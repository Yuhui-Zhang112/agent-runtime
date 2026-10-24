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
 */

import { callModel, estimateCostUSD } from './callModel.js'
import { runTool, type ToolContext, type ToolRegistry } from './tool.js'
import type { ModelProvider } from '../api/types.js'
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
  toolResults: Array<{ toolUseId: string; isError: boolean; chars: number }>
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
}

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
  } = opts

  const traces: TurnTrace[] = []
  const ctx: ToolContext = { cwd, signal }

  for (let turn = 1; turn <= maxTurns; turn += 1) {
    if (signal?.aborted) return finish('aborted', turn - 1, messages, traces)

    // ① 问模型（流式）。最后一个快照是终态
    const startedAt = Date.now()
    let assistant: AssistantMessage
    try {
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
      if (!last) return finish('error', turn - 1, messages, traces, new Error('模型没有返回任何内容'))
      assistant = last
    } catch (err) {
      // 网络错误：不把半成品消息推进历史，避免留下无人配对的 tool_use
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
      tracer?.onTurn?.(
        makeTrace(turn, model, durationMs, assistant, messages, [], usage),
      )
      return finish('end_turn', turn, messages, traces)
    }

    // ③ 执行工具。**每一个 tool_use 都必须产出一个 tool_result**
    const resultBlocks: ContentBlock[] = []
    const toolResults: TurnTrace['toolResults'] = []

    for (const tu of toolUses) {
      let output: string
      let isError = false

      if (signal?.aborted) {
        // 被取消：不能真的去执行，但结果位必须补上，否则配对断裂
        output = '已取消（用户中断）'
        isError = true
      } else {
        const tool = tools.get(tu.name)
        const res = tool
          ? await runTool(tool, tu.input, ctx)
          : { output: `未知工具：${tu.name}。可用工具：${tools.list().map((t) => t.name).join(', ')}`, isError: true }
        output = res.output
        isError = res.isError === true
      }

      if (output.length > maxToolResultChars) {
        output =
          output.slice(0, maxToolResultChars) +
          `\n\n[已截断：原始 ${output.length} 字符，保留前 ${maxToolResultChars} 字符]`
      }

      resultBlocks.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: output,
        ...(isError ? { is_error: true } : {}),
      })
      toolResults.push({ toolUseId: tu.id, isError, chars: output.length })
    }

    // ④ 把结果作为一条"用户消息"回传，继续下一轮
    messages.push(createUserMessage(resultBlocks, assistant.uuid))
    tracer?.onTurn?.(
      makeTrace(turn, model, durationMs, assistant, messages, toolResults, usage),
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
  toolResults: TurnTrace['toolResults'],
  usage: AssistantMessage['message']['usage'],
): TurnTrace {
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
