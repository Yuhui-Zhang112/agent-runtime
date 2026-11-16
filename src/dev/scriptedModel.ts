/**
 * 剧本模型（ScriptedProvider）
 *
 * 它冒充一个真实的模型厂商，但**不联网、不花钱、完全确定性**。
 * 你预先写好"每一轮模型该说什么"，它就一字不差地照着演。
 *
 * 为什么必须有它：
 *  1. 主循环写完后要测各种极端场景（连调 5 次工具、中途按 Ctrl+C、
 *     网络突然断了）。这些在真 API 上根本没法稳定复现 —— 你不知道
 *     网络什么时候把 JSON 切断，也不知道模型什么时候恰好想调 5 次工具。
 *  2. 它是后面做 Eval 对照实验的地基：同一批任务，换压缩策略再跑一遍，
 *     除了策略以外的变量必须完全锁死，靠真模型做不到。
 *
 * 它输出的是**标准流事件**（跟真实 provider 一模一样），
 * 所以 callModel / 主循环完全感觉不到自己在跟一个"假模型"说话。
 */

import type { ModelProvider, ModelRequest, StreamEvent } from '../api/types.js'
import type { Usage } from '../types/message.js'

export type ScriptedBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id?: string; name: string; input: unknown }

export interface ScriptedTurn {
  /** 这一轮模型要输出的内容块 */
  blocks: ScriptedBlock[]
  usage?: Partial<Usage>
  /** 切片大小：把文本和 JSON 切成这么大的片段发出去，模拟真实流式。默认 8 */
  chunkSize?: number
  /** 发到第 n 个事件后抛 AbortError —— 模拟用户按 Ctrl+C */
  abortAfterEvents?: number
  /** 发到第 n 个事件后抛普通错误 —— 模拟网络中断 */
  failAfterEvents?: number
  /** 每个事件之间的延迟（ms），用来让测试更接近真实节奏。默认 0 */
  delayMs?: number
}

export class ScriptedProvider implements ModelProvider {
  readonly name = 'scripted'
  /** 已被调用过几轮 —— 主循环每问一次模型就 +1 */
  calls = 0
  /** 记录每次收到的请求，测试里可以断言"工具清单有没有发给模型" */
  readonly requests: ModelRequest[] = []

  constructor(private readonly turns: ScriptedTurn[]) {
    if (turns.length === 0) throw new Error('ScriptedProvider 至少需要一个 turn')
  }

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    // 剧本演完了就重复最后一幕，避免数组越界
    const idx = Math.min(this.calls, this.turns.length - 1)
    const turn = this.turns[idx]!
    this.calls += 1
    this.requests.push(req)

    const chunkSize = turn.chunkSize ?? 8
    const events = buildEvents(turn, chunkSize, req.model)

    let emitted = 0
    for (const ev of events) {
      if (req.signal?.aborted) throw abortError()
      if (turn.delayMs) await sleep(turn.delayMs)

      yield ev
      emitted += 1

      if (turn.abortAfterEvents !== undefined && emitted >= turn.abortAfterEvents) {
        throw abortError()
      }
      if (turn.failAfterEvents !== undefined && emitted >= turn.failAfterEvents) {
        throw new Error('模拟网络中断')
      }
    }
  }
}

// ── 事件构造 ────────────────────────────────────────────────

/** 把一"幕"剧本展开成标准流事件序列。导出给评测模型复用，避免两套 SSE 构造逻辑 */
export function buildEvents(turn: ScriptedTurn, chunkSize: number, _model: string): StreamEvent[] {
  const events: StreamEvent[] = []

  events.push({
    type: 'message_start',
    usage: {
      input_tokens: turn.usage?.input_tokens ?? 1000,
      output_tokens: 0,
      ...turn.usage,
    },
  })

  let hasToolUse = false
  turn.blocks.forEach((block, index) => {
    if (block.type === 'text') {
      events.push({ type: 'content_block_start', index, block: { type: 'text', text: '' } })
      for (const piece of chunk(block.text, chunkSize)) {
        events.push({ type: 'content_block_delta', index, delta: { type: 'text_delta', text: piece } })
      }
      events.push({ type: 'content_block_stop', index })
    } else {
      hasToolUse = true
      const id = block.id ?? `tu_${index}`
      events.push({
        type: 'content_block_start',
        index,
        block: { type: 'tool_use', id, name: block.name, input: {} },
      })
      // 关键：把 JSON 切碎发出去，专门用来测"被腰斩的 JSON 能不能还原"
      const json = JSON.stringify(block.input ?? {})
      for (const piece of chunk(json, chunkSize)) {
        events.push({
          type: 'content_block_delta',
          index,
          delta: { type: 'input_json_delta', partial_json: piece },
        })
      }
      events.push({ type: 'content_block_stop', index })
    }
  })

  events.push({
    type: 'message_delta',
    stopReason: hasToolUse ? 'tool_use' : 'end_turn',
    usage: { output_tokens: turn.usage?.output_tokens ?? 50 },
  })
  events.push({ type: 'message_stop' })
  return events
}

function chunk(s: string, size: number): string[] {
  if (s.length === 0) return ['']
  const out: string[] = []
  for (let i = 0; i < s.length; i += size) out.push(s.slice(i, i + size))
  return out
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function abortError(): Error {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}
