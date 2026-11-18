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
import { buildEvents } from '../core/streamEvents.js'

// 类型与事件构造统一住在 core/streamEvents.ts（生产层），这里 re-export 保持旧调用方零改动
export type { ScriptedBlock, ScriptedTurn } from '../core/streamEvents.js'
import type { ScriptedTurn } from '../core/streamEvents.js'

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

// ── 辅助 ────────────────────────────────────────────────────

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

function abortError(): Error {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}
