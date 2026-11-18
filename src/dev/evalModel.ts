/**
 * 评测模型（EvalProvider）—— 一个会「读历史」的确定性假模型
 *
 * 为什么不能直接用 ScriptedProvider 做 A/B：
 *   剧本模型只会照本宣科，无论历史被压成什么样，它最后一幕都输出同一句话。
 *   那样 A 组和 B 组的最终结果必然相同，实验测出的是 0 —— 假实验。
 *
 * 这个模型多了两件真模型才有的性质，但依然**零 API key、完全确定**：
 *   1. 它的 input_tokens 按「这一轮真正发给它的 messages」现算，
 *      所以压缩有没有少发 token，会真实反映在成本上。
 *   2. 它在最后一轮**检查历史里还在不在那个精确值**：
 *      在 → 答对；不在 → 要么按占位符提示重新 Read 取回，要么只能答 UNKNOWN。
 *
 * 于是「压缩省了钱」和「压缩让引用丢失」第一次变成同一把尺子上的两个数。
 *
 * 诚实边界（必须写进实验报告）：这不是真 LLM，它模拟的是
 * 「信息在上下文里是否可达」这一条机制，不模拟真模型的注意力衰减、
 * 幻觉倾向或指令遵循能力。它给出的数字是**架构层的可达性指标**，
 * 不是「真实业务任务成功率」。
 */

import {
  buildEvents,
  type ScriptedBlock,
  type ScriptedTurn,
} from '../core/streamEvents.js'
import type { ModelProvider, ModelRequest, StreamEvent } from '../api/types.js'
import { estimateTokens, type Message } from '../types/message.js'
import { PLACEHOLDER_PREFIX } from '../core/compaction.js'
import { NOISE_ROUNDS, type EvalTask } from './evalTasks.js'

export interface EvalProviderOptions {
  task: EvalTask
  /** 是否模拟「遵循占位符提示、回去重新 Read」的模型。B 组设 false 作退化对照 */
  allowRecovery: boolean
  noiseRounds?: number
  /** 输出 token 固定值 —— 输出侧不是本实验的变量，锁死它 */
  outputTokens?: number
}

export const ANSWER_PREFIX = 'ANSWER: '
export const UNKNOWN_ANSWER = 'ANSWER: UNKNOWN'

/** 把历史摊平成一段文本，用来判断「精确值还可达吗」 */
export function flattenHistory(messages: Message[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.type === 'user') {
      if (typeof m.message.content === 'string') {
        parts.push(m.message.content)
      } else {
        for (const b of m.message.content) {
          if (b.type === 'tool_result' && typeof b.content === 'string') parts.push(b.content)
          else if (b.type === 'text') parts.push(b.text)
        }
      }
    } else if (m.type === 'assistant') {
      for (const b of m.message.content) if (b.type === 'text') parts.push(b.text)
    }
  }
  return parts.join('\n')
}

/**
 * 估算这一轮真实发给模型的输入 token。
 * 历史是可变的（压缩会改它），system 与 tools 是常量 —— A/B 的差异全部来自历史。
 * 这是估算而非厂商计数；同一套估算用在三组上，对照关系成立。
 */
export function estimateRequestTokens(req: ModelRequest): number {
  const history = req.messages.reduce((s, m) => s + estimateTokens(m), 0)
  const system = Math.ceil(req.system.length / 4)
  const tools = Math.ceil(JSON.stringify(req.tools).length / 4)
  return history + system + tools
}

export class EvalProvider implements ModelProvider {
  readonly name = 'eval'
  calls = 0
  /** 因为信息被折叠而额外发生的重读次数 —— 压缩的隐性成本 */
  recoveries = 0
  /** 每次请求实际计算的 input_tokens，实验的原始证据 */
  readonly inputTokens: number[] = []
  readonly requests: ModelRequest[] = []

  constructor(private readonly opts: EvalProviderOptions) {}

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    this.calls += 1
    this.requests.push(req)

    const inputTokens = estimateRequestTokens(req)
    this.inputTokens.push(inputTokens)

    const blocks = this.decide(req)
    const turn: ScriptedTurn = {
      blocks,
      usage: {
        input_tokens: inputTokens,
        output_tokens: this.opts.outputTokens ?? 50,
      },
    }

    // 复用剧本模型那套标准 SSE 事件构造 —— 验证层只有一份实现，不另起炉灶
    for (const ev of buildEvents(turn, 64, req.model)) {
      if (req.signal?.aborted) return
      yield ev
    }
  }

  private decide(req: ModelRequest): ScriptedBlock[] {
    const { task, allowRecovery } = this.opts
    const noiseRounds = this.opts.noiseRounds ?? NOISE_ROUNDS
    const n = this.calls

    // ① 第一轮：读埋值文件
    if (n === 1) return [read(n, task.targetPath)]
    // ② 中间若干轮：读大文件制造上下文膨胀，把埋值结果挤到历史早期
    if (n <= 1 + noiseRounds) {
      const noise = task.noisePaths[(n - 2) % task.noisePaths.length]!
      return [read(n, noise)]
    }

    // ③ 该回答了：精确值还在上下文里吗？
    const history = flattenHistory(req.messages)
    if (history.includes(task.secret)) {
      return [{ type: 'text', text: `${ANSWER_PREFIX}${task.secret}` }]
    }

    // 不在，但看到了「可重新取回」的折叠标记，且还没重读过 → 回去取
    const sawPlaceholder = history.includes(PLACEHOLDER_PREFIX)
    if (allowRecovery && sawPlaceholder && this.recoveries === 0) {
      this.recoveries += 1
      return [read(n, task.targetPath)]
    }

    // 既不可达、也取不回 → 只能承认不知道（记一次引用丢失）
    return [{ type: 'text', text: UNKNOWN_ANSWER }]
  }
}

/** tool_use id 必须每轮唯一，否则配对检测会把不同轮次的调用混成同一个 */
function read(turn: number, path: string): ScriptedBlock {
  return {
    type: 'tool_use',
    id: `tu_eval_${turn}`,
    name: 'Read',
    input: { path },
  }
}
