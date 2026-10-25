/**
 * 会话存储
 *
 * CLI 是单会话、单用户，什么都不用管。服务化之后立刻出现三个新问题：
 *
 *  1. 【会话隔离】多个用户同时用，各自的消息历史不能混。
 *  2. 【同会话必须串行】runAgent 是**就地追加** messages 的。同一会话两个请求
 *     并发跑，两条消息链会交错写入 —— 轻则上下文串味，重则 tool_use 找不到
 *     配对的 tool_result，会话直接死锁。所以加了 busy 锁，抢不到就 409。
 *     （这不是性能妥协：正确性优先。）
 *  3. 【成本要有人管】模型调用是花钱的。没有上限，一个死循环请求就能烧掉
 *     你一个月的额度。所以每个会话单独记账，超预算直接拒绝。
 */

import { createUuid, type Message } from '../types/message.js'

export interface Session {
  id: string
  messages: Message[]
  /** 累计花费（USD） */
  costUSD: number
  /** 累计跑了几轮模型调用 */
  turns: number
  /** 已跑过几次 run */
  runs: number
  createdAt: number
  updatedAt: number
  /** 有 run 正在跑。true 时拒绝新请求 */
  busy: boolean
}

export interface SessionSummary {
  id: string
  turns: number
  runs: number
  costUSD: number
  messages: number
  busy: boolean
  createdAt: number
  updatedAt: number
}

export class SessionStore {
  private readonly map = new Map<string, Session>()

  create(id: string = createUuid()): Session {
    const now = Date.now()
    const s: Session = {
      id,
      messages: [],
      costUSD: 0,
      turns: 0,
      runs: 0,
      createdAt: now,
      updatedAt: now,
      busy: false,
    }
    this.map.set(id, s)
    return s
  }

  get(id: string): Session | undefined {
    return this.map.get(id)
  }

  has(id: string): boolean {
    return this.map.has(id)
  }

  delete(id: string): boolean {
    const s = this.map.get(id)
    // 正在跑的会话不许删 —— 删了它的结果就没地方写了
    if (s?.busy) return false
    return this.map.delete(id)
  }

  list(): SessionSummary[] {
    return [...this.map.values()].map(summarize)
  }

  /** 抢占执行权。false = 这个会话正忙 */
  acquire(id: string): boolean {
    const s = this.map.get(id)
    if (!s || s.busy) return false
    s.busy = true
    s.updatedAt = Date.now()
    return true
  }

  release(id: string): void {
    const s = this.map.get(id)
    if (!s) return
    s.busy = false
    s.updatedAt = Date.now()
  }

  /** 记账。返回记账后的累计值 */
  charge(id: string, costUSD: number, turns: number): void {
    const s = this.map.get(id)
    if (!s) return
    s.costUSD += costUSD
    s.turns += turns
    s.runs += 1
    s.updatedAt = Date.now()
  }

  /** 回收空闲会话，防止长期运行内存无限增长 */
  sweep(idleTTLms: number, now = Date.now()): number {
    let n = 0
    for (const [id, s] of this.map) {
      if (s.busy) continue
      if (now - s.updatedAt > idleTTLms) {
        this.map.delete(id)
        n += 1
      }
    }
    return n
  }
}

export function summarize(s: Session): SessionSummary {
  return {
    id: s.id,
    turns: s.turns,
    runs: s.runs,
    costUSD: s.costUSD,
    messages: s.messages.length,
    busy: s.busy,
    createdAt: s.createdAt,
    updatedAt: s.updatedAt,
  }
}
