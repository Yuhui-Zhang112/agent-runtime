/**
 * 服务形态的审批门（Approval Queue）
 *
 * CLI 里"要不要批准"是终端里问一句；服务没有终端，所以把它变成一个
 * **可被 HTTP 编排的异步请求**：
 *
 *   主循环要跑命令 → engine 判定需要批准 → 挂起
 *   → SSE 推 permission_request（带 id）
 *   → 调用方 POST /v1/approvals { id, decision }
 *   → 队列 resolve，主循环继续
 *
 * 三条硬规矩：
 *  1. 审批不能无限等：engine 会超时判 deny，队列自己也带自清定时器，
 *     避免超时后 pending 永久堆积。
 *  2. 客户端断开（abort）→ 立刻按 deny 收敛，不留悬挂的 Promise。
 *  3. 服务关闭时 rejectAll()，不让在跑的 run 卡在审批上。
 */

import type {
  ApprovalDecision,
  ApprovalGate,
  PermissionRequest,
} from '../core/permissions.js'

export interface PendingApproval {
  id: string
  toolName: string
  target: string
  reason: string
  level: string
  timeoutMs: number
  createdAt: number
}

interface Entry {
  info: PendingApproval
  resolve: (d: ApprovalDecision) => void
  timer: ReturnType<typeof setTimeout>
}

export class ApprovalQueue {
  private readonly pending = new Map<string, Entry>()

  /** 有新审批请求 / 请求被处理时通知外界（SSE 与日志） */
  onRequest?: (a: PendingApproval) => void
  onResolved?: (id: string, decision: ApprovalDecision) => void

  /** 直接传给 PermissionEngine 的 gate */
  readonly gate: ApprovalGate = (req: PermissionRequest, signal?: AbortSignal) =>
    new Promise<ApprovalDecision>((resolveDecision) => {
      const info: PendingApproval = {
        id: req.id,
        toolName: req.toolName,
        target: req.target,
        reason: req.reason,
        level: req.level,
        timeoutMs: req.timeoutMs,
        createdAt: Date.now(),
      }

      const finish = (d: ApprovalDecision): void => {
        const entry = this.pending.get(req.id)
        if (!entry) return
        this.pending.delete(req.id)
        clearTimeout(entry.timer)
        signal?.removeEventListener('abort', onAbort)
        resolveDecision(d)
        this.onResolved?.(req.id, d)
      }

      // 自清：engine 那边超时判 deny 之后，这里也把挂起项收掉
      const timer = setTimeout(() => finish('deny'), req.timeoutMs + 250)
      const onAbort = () => finish('deny')

      this.pending.set(req.id, { info, resolve: resolveDecision, timer })
      signal?.addEventListener('abort', onAbort, { once: true })
      this.onRequest?.(info)
    })

  /** 返回 false 表示 id 不存在（可能已被审批或超时清理） */
  resolve(id: string, decision: ApprovalDecision): boolean {
    const entry = this.pending.get(id)
    if (!entry) return false
    this.pending.delete(id)
    clearTimeout(entry.timer)
    entry.resolve(decision)
    this.onResolved?.(id, decision)
    return true
  }

  /** 服务关闭：所有挂起的审批一律拒绝 */
  rejectAll(): number {
    const n = this.pending.size
    for (const [id, entry] of [...this.pending]) {
      this.pending.delete(id)
      clearTimeout(entry.timer)
      entry.resolve('deny')
      this.onResolved?.(id, 'deny')
    }
    return n
  }

  list(): PendingApproval[] {
    return [...this.pending.values()].map((e) => e.info)
  }

  get size(): number {
    return this.pending.size
  }
}
