/**
 * 标准流事件构造器（生产层）
 *
 * 原先住在 dev/scriptedModel.ts 里。场景 Agent 属于生产代码，不能 import
 * 被 tsconfig.build.json 排除的 dev/ 目录，所以这层抽到 core/，
 * 剧本模型与评测模型改为从这里复用 —— 依然只有一份 SSE 构造逻辑。
 *
 * 真实 provider 与假模型输出的是同一套事件形状，主循环因此分不清
 * （也不需要分清）对面是谁。
 */

import type { StreamEvent } from '../api/types.js'

export type ScriptedBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id?: string; name: string; input: unknown }

export interface ScriptedTurn {
  blocks: ScriptedBlock[]
  usage?: { input_tokens?: number; output_tokens?: number }
  /** 切片大小：把文本和 JSON 切成这么大的片段发出去，模拟真实流式 */
  chunkSize?: number
  /** 发到第 n 个事件后抛 AbortError —— 模拟用户按 Ctrl+C */
  abortAfterEvents?: number
  /** 发到第 n 个事件后抛普通错误 —— 模拟网络中断 */
  failAfterEvents?: number
  /** 每个事件之间的延迟（ms） */
  delayMs?: number
}

/** 把一"幕"剧本展开成标准流事件序列 */
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
      // 把 JSON 切碎发出去，专门用来测「被腰斩的 JSON 能不能还原」
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
