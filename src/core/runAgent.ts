/**
 * runAgent —— 主循环（Agent 的大脑）
 *
 * 它做的事用一句大白话说就是：
 *   「问模型 → 它说要干活就去干 → 把结果告诉它 → 再问 → 直到它不再要干活」
 *
 * 四件必须做对的事（参考源码里踩过的坑）：
 *
 *  1. 【配对不可断】每一个 tool_use 都必须有一个 tool_result。
 *     少一个，API 直接 400，会话永久死锁。中断、取消、异常三条路径都要补齐。
 *
 *  2. 【不能信 stop_reason】源码 query.ts:554 原注释：
 *     "stop_reason === 'tool_use' is unreliable -- it's not always set correctly"
 *     唯一可信的信号是：这一轮的回复里**有没有出现 tool_use 块**。
 *
 *  3. 【Trace 从第一天就埋】每一轮记一条 trace。现在不埋，Phase 5 要重写主循环。
 *
 *  4. 【策略可注入】provider / tracer / budgetPolicy 全部从外面传进来。
 *     这样同一套循环既能跑真模型，也能跑剧本模型（做对照实验）。
 *
 *  5. 【并发但要守规矩】一轮里模型常要调好几个工具。只读且声明了
 *     isConcurrencySafe 的可以一起跑，会改东西的必须独占。
 *     并发规则全在 core/toolExecution.ts，这里只负责调用。
 *     无论怎么并发，结果顺序都必须与模型请求顺序一致。
 *
 *  6. 【网络一定会抖】限流、过载、连接重置都是正常现象，不该让任务崩掉。
 *     重试包在"整轮"外面：流式读到一半失败时丢弃已收快照、整轮重来。
 *     之所以安全，是因为此时还没把任何 assistant 消息推进历史，
 *     不会留下无人配对的 tool_use（详见 core/withRetry.ts）。
 */

import { callModel, estimateCostUSD } from './callModel.js'
import { withRetry, type RetryPolicy, type RetryInfo } from './withRetry.js'
import {
  executeToolUses,
  type ExecutedTool,
  type ToolUseRef,
} from './toolExecution.js'
import type { ToolContext, ToolRegistry } from './tool.js'
import { ProviderError, type ModelProvider } from '../api/types.js'
import {
  createUserMessage,
  estimateTokens,
  extractToolUses,
  type AssistantMessage,
  type ContentBlock,
  type Message,
} from '../types/message.js'

// ── Trace ───────────────────────────────────────────────────

/** 一轮的观测记录。Phase 5 的可视化和 Eval 全靠这些数据 */
export interface TurnTrace {
  turn: number
  model: string
  durationMs: number
  inputTokens: number
  outputTokens: number
  /** 本轮上下文总 token（估算）—— 画"上下文增长曲线"用的就是它 */
  contextTokens: number
  costUSD: number
  stopReason: string | null
  toolUses: Array<{ id: string; name: string }>
  toolResults: Array<{
    toolUseId: string
    name: string
    isError: boolean
    chars: number
    /** 单个工具耗时 —— 用来定位"到底哪一步慢" */
    durationMs: number
    /** 第几个波次：同一波次 = 并发执行的。用来算"并发省了多少时间" */
    wave: number
  }>
  /** 本轮工具执行的墙钟总耗时 */
  toolMs: number
  /** 本轮最多有几个工具同时在跑（1 = 全串行） */
  maxConcurrency: number
  /** 本轮模型调用重试了几次。Eval 里"重试率"是重要的稳定性指标 */
  retries: number
}

export interface Tracer {
  onTurn?(trace: TurnTrace): void
}

// ── 选项与结果 ───────────────────────────────────────────────

export interface RunAgentOptions {
  provider: ModelProvider
  model: string
  system: string
  tools: ToolRegistry
  /** 消息历史，会被就地追加（调用方持有引用即可拿到完整轨迹） */
  messages: Message[]
  cwd?: string
  maxTurns?: number
  maxTokens?: number
  signal?: AbortSignal
  tracer?: Tracer
  /** 单条工具结果的最大字符数 —— 上下文工程的第一道防线 */
  maxToolResultChars?: number
  /** 一波里最多同时跑几个工具。默认 8 */
  maxParallel?: number
  /** 工具开始/结束的实时事件，UI 用它显示进度 */
  onToolEvent?: (e: ToolEvent) => void
  /** 重试策略。不传就用 DEFAULT_RETRY_POLICY（3 次、500ms 起、8s 封顶） */
  retry?: Partial<RetryPolicy>
  /** 每次决定重试时回调，用于打印"网络抖动，第 N 次重试…" */
  onRetry?: (info: RetryInfo) => void
}

/** 工具执行事件。phase=start 时只有 id/name/wave；phase=end 时带完整结果 */
export type ToolEvent =
  | { phase: 'start'; id: string; name: string; wave: number }
  | ({ phase: 'end' } & ExecutedTool)

/** tool_use 的引用结构（与调度器共用，避免重复定义） */
export type { ToolUseRef } from './toolExecution.js'

export type StopReason = 'end_turn' | 'max_turns' | 'aborted' | 'error'

export interface RunAgentResult {
  stopReason: StopReason
  turns: number
  finalText: string
  traces: TurnTrace[]
  error?: Error
}

const DEFAULT_MAX_TURNS = 20
const DEFAULT_MAX_RESULT_CHARS = 30_000
const DEFAULT_MAX_PARALLEL = 8

// ── 主循环 ──────────────────────────────────────────────────

export async function runAgent(opts: RunAgentOptions): Promise<RunAgentResult> {
  const {
    provider,
    model,
    system,
    tools,
    messages,
    cwd = process.cwd(),
    maxTurns = DEFAULT_MAX_TURNS,
    maxTokens = 4096,
    signal,
    tracer,
    maxToolResultChars = DEFAULT_MAX_RESULT_CHARS,
    maxParallel = DEFAULT_MAX_PARALLEL,
    onToolEvent,
    retry,
    onRetry,
  } = opts

  const traces: TurnTrace[] = []
  const ctx: ToolContext = { cwd, signal }

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (signal?.aborted) return finish('aborted', turn - 1, messages, traces)

    // ① 问模型（流式）。最后一个快照是终态
    //
    //    重试包在"整轮"外面而不是流内部：流式读到一半失败时，
    //    已收到的快照全部丢弃、整轮重来。这是安全的 —— 我们还没有把任何
    //    半成品 assistant 消息推进历史，所以不会留下无人配对的 tool_use。
    const startedAt = Date.now()
    let assistant: AssistantMessage
    let retries = 0
    try {
      assistant = await withRetry(async () => {
        let last: AssistantMessage | undefined
        for await (const snap of callModel(
          provider,
          {
            model,
            system,
            messages,
            tools: tools.specs(),
            maxTokens,
            signal,
          },
          { parentUuid: messages.at(-1)?.uuid ?? null },
        )) {
          last = snap
        }
        // 空响应是个真实存在的坑：某些 provider 偶尔返回一条什么都没有的消息。
        // 不算成功，标成可重试让它再来一次
        if (!last || last.message.content.length === 0) {
          throw new ProviderError('模型返回了空响应', undefined, true)
        }
        return last
      }, {
        ...retry,
        signal,
        onRetry: (info) => {
          retries = info.attempt
          onRetry?.(info)
        },
      })
    } catch (err) {
      // 重试也救不回来：不把半成品消息推进历史，避免留下无人配对的 tool_use
      return finish(
        'error',
        turn - 1,
        messages,
        traces,
        err instanceof Error ? err : new Error(String(err)),
      )
    }

    messages.push(assistant)

    const toolUses = extractToolUses(assistant)
    const durationMs = Date.now() - startedAt
    const usage = assistant.message.usage

    // ② 不再要工具 → 这一轮就是最终答案，循环结束
    if (toolUses.length === 0) {
      tracer?.onTurn?.(makeTrace(turn, model, durationMs, assistant, messages, [], 0, usage, retries))
      return finish('end_turn', turn, messages, traces)
    }

    // ③ 执行工具。**每一个 tool_use 都必须产出一个 tool_result**
    //
    //   并发规则在 toolExecution.ts 里：只读且声明了可并发的工具一起跑，
    //   会改东西的工具独占。无论怎么并发，返回顺序都跟模型请求顺序一致。
    const startedToolsAt = Date.now()
    const executed = await executeToolUses({
      toolUses,
      tools,
      ctx,
      maxResultChars: maxToolResultChars,
      maxParallel,
      onToolStart: (i) => onToolEvent?.({ phase: 'start', ...i }),
      onToolEnd: (e) => onToolEvent?.({ phase: 'end', ...e }),
    })
    const toolMs = Date.now() - startedToolsAt

    const resultBlocks: ContentBlock[] = executed.map((e) => ({
      type: 'tool_result',
      tool_use_id: e.toolUseId,
      content: e.output,
      ...(e.isError ? { is_error: true } : {}),
    }))

    // ④ 把结果作为一条"用户消息"回传，继续下一轮
    messages.push(createUserMessage(resultBlocks, assistant.uuid))
    tracer?.onTurn?.(
      makeTrace(turn, model, durationMs, assistant, messages, executed, toolMs, usage, retries),
    )

    if (signal?.aborted) return finish('aborted', turn, messages, traces)
  }

  return finish('max_turns', maxTurns, messages, traces)
}

// ── 辅助 ────────────────────────────────────────────────────

function makeTrace(
  turn: number,
  model: string,
  durationMs: number,
  assistant: AssistantMessage,
  messages: Message[],
  executed: ExecutedTool[],
  toolMs: number,
  usage: AssistantMessage['message']['usage'],
  retries: number,
): TurnTrace {
  const toolResults = executed.map((e) => ({
    toolUseId: e.toolUseId,
    name: e.name,
    isError: e.isError,
    chars: e.output.length,
    durationMs: e.durationMs,
    wave: e.wave,
  }))

  // 同一波次里有几个工具 = 那一波的实际并发度
  const perWave = new Map<number, number>()
  for (const r of toolResults) perWave.set(r.wave, (perWave.get(r.wave) ?? 0) + 1)

  return {
    turn,
    model,
    durationMs,
    inputTokens: usage?.input_tokens ?? 0,
    outputTokens: usage?.output_tokens ?? 0,
    contextTokens: messages.reduce((sum, m) => sum + estimateTokens(m), 0),
    costUSD: estimateCostUSD(model, usage),
    stopReason: assistant.message.stop_reason,
    toolUses: extractToolUses(assistant).map((t) => ({ id: t.id, name: t.name })),
    toolResults,
    toolMs,
    maxConcurrency: toolResults.length === 0 ? 0 : Math.max(...perWave.values()),
    retries,
  }
}

function finish(
  stopReason: StopReason,
  turns: number,
  messages: Message[],
  traces: TurnTrace[],
  error?: Error,
): RunAgentResult {
  return { stopReason, turns, finalText: lastAssistantText(messages), traces, error }
}

function lastAssistantText(messages: Message[]): string {
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const m = messages[i]
    if (m?.type !== 'assistant') continue
    return m.message.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
  }
  return ''
}

/**
 * 体检：找出所有"有 tool_use 却没有配对 tool_result"的孤儿。
 * 正常情况必须为空数组 —— 不为空说明会话已经处于死锁状态。
 */
export function findOrphanToolUses(messages: Message[]): string[] {
  const orphans = new Set<string>()
  const answered = new Set<string>()

  for (const m of messages) {
    if (m.type === 'assistant') {
      for (const b of m.message.content) {
        if (b.type === 'tool_use') orphans.add(b.id)
      }
    }
    if (m.type === 'user' && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (b.type === 'tool_result') answered.add(b.tool_use_id)
      }
    }
  }
  for (const id of answered) orphans.delete(id)
  return [...orphans]
}
