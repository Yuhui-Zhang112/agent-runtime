/**
 * callModel —— 流式调用的唯一入口
 *
 * 职责：把 provider 的流事件累积成结构化的 AssistantMessage，并**逐步 yield**
 * （每收到 content_block_stop 就产出一个快照），让上层 UI 能边流边渲染。
 * 最后 yield 的那一条是完整消息，含 usage / stop_reason / durationMs。
 *
 * 为什么不用 `return` 传最终值：for-await 拿不到 generator 的 return value，
 * 参考源码同样采用"最后一个 yield 即终态"的约定。
 */

import type { AssistantMessage, ContentBlock, Usage } from '../types/message.js'
import { createAssistantMessage } from '../types/message.js'
import type { ModelProvider, ModelRequest, StreamEvent } from '../api/types.js'

export interface CallModelOptions {
  parentUuid?: string | null
  /** 用于统计耗时，Trace 的关键字段 */
  now?: () => number
}

export async function* callModel(
  provider: ModelProvider,
  req: ModelRequest,
  opts: CallModelOptions = {},
): AsyncGenerator<AssistantMessage> {
  const now = opts.now ?? Date.now
  const startedAt = now()

  /** index → 累积中的内容块。用 Map 是因为事件到达顺序不保证连续 */
  const blocks = new Map<number, ContentBlock>()
  /** tool_use 块的原始 JSON 累积器（增量到达，必须拼完才能 parse） */
  const rawJson = new Map<number, string>()

  let usage: Usage | undefined
  let stopReason: string | null = null

  const snapshot = (): AssistantMessage =>
    createAssistantMessage(
      [...blocks.entries()].sort((a, b) => a[0] - b[0]).map(([, b]) => b),
      opts.parentUuid ?? null,
      { model: req.model, stopReason, usage, durationMs: now() - startedAt },
    )

  try {
    for await (const event of provider.stream(req)) {
      switch (event.type) {
        case 'message_start':
          if (event.usage) usage = event.usage
          break

        case 'content_block_start': {
          const b = event.block
          if (b.type === 'text') {
            blocks.set(event.index, { type: 'text', text: b.text ?? '' })
          } else if (b.type === 'tool_use') {
            blocks.set(event.index, {
              type: 'tool_use',
              id: b.id ?? '',
              name: b.name ?? '',
              input: {},
            })
            rawJson.set(event.index, '')
          } else if (b.type === 'thinking') {
            blocks.set(event.index, { type: 'thinking', thinking: b.thinking ?? '' })
          } else if (b.type === 'redacted_thinking') {
            blocks.set(event.index, { type: 'redacted_thinking', data: b.data ?? '' })
          }
          break
        }

        case 'content_block_delta': {
          const block = blocks.get(event.index)
          if (!block) break
          const d = event.delta
          if (d.type === 'text_delta' && block.type === 'text') {
            block.text += d.text
          } else if (d.type === 'thinking_delta' && block.type === 'thinking') {
            block.thinking += d.thinking
          } else if (d.type === 'input_json_delta') {
            rawJson.set(event.index, (rawJson.get(event.index) ?? '') + d.partial_json)
          }
          break
        }

        case 'content_block_stop': {
          const block = blocks.get(event.index)
          if (block?.type === 'tool_use') {
            // 增量 JSON 可能不完整 —— parse 失败时保留空对象，绝不让主循环崩
            const raw = rawJson.get(event.index) ?? ''
            try {
              block.input = raw ? JSON.parse(raw) : {}
            } catch {
              block.input = {}
            }
          }
          yield snapshot()
          break
        }

        case 'message_delta':
          if (event.usage) usage = { ...usage, ...event.usage } as Usage
          if (event.stopReason !== undefined) stopReason = event.stopReason
          break

        case 'message_stop':
          break

        case 'error':
          throw event.error
      }
    }
  } catch (err) {
    // 被主动中断不视为错误：把已收到的内容作为终态交回主循环，
    // 由上层负责补齐 tool_result 配对（参考源码的 ensureToolResultPairing）
    if (isAbortError(err) || req.signal?.aborted) {
      yield snapshot()
      return
    }
    throw err
  }

  yield snapshot()
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === 'AbortError' || err.name === 'APIUserAbortError')
}

// ── 成本估算 ────────────────────────────────────────────────

/** 单价（USD / 百万 token）。cache 写入 1.25x、读取 0.1x 是 Anthropic 的计价规则 */
const PRICING: Record<string, { in: number; out: number }> = {
  'claude-opus-4': { in: 15, out: 75 },
  'claude-sonnet-4': { in: 3, out: 15 },
  'claude-haiku-4': { in: 0.8, out: 4 },
}

export function estimateCostUSD(model: string, usage?: Usage): number {
  if (!usage) return 0
  const p = PRICING[model] ?? { in: 3, out: 15 }
  const input = usage.input_tokens ?? 0
  const cacheWrite = usage.cache_creation_input_tokens ?? 0
  const cacheRead = usage.cache_read_input_tokens ?? 0
  const output = usage.output_tokens ?? 0
  return (
    (input * p.in + cacheWrite * p.in * 1.25 + cacheRead * p.in * 0.1 + output * p.out) / 1_000_000
  )
}
