/**
 * 错误分类（Retry 的唯一判据）
 *
 * 为什么要有这一层：各家 SDK 抛的错误形状完全不一样 ——
 * Anthropic 抛 `APIError`（带 status），OpenAI 兼容那边是原生 fetch 抛的
 * `TypeError: fetch failed`（什么都不带）。如果重试逻辑直接去 try/catch，
 * 就只能靠匹配错误**消息文本**来猜能不能重试，那既脆弱又不可维护。
 *
 * 所以约定：**provider 负责把自家错误翻译成 ProviderError**，
 * 带上 status 和 retryable。重试策略只认这一个类型，不认识任何厂商。
 *
 * 判定原则（保守）：
 *   - 明确的服务端临时故障 → 重试（429 限流、5xx、529 过载）
 *   - 明确的网络层故障 → 重试（连接重置、超时、socket 断开）
 *   - 4xx（除 408/409/429）→ 不重试。这是我们的请求写错了，
 *     重试一百次还是错的，只会白白花钱
 *   - **认不出来的错误 → 不重试**。可能是代码 bug，盲目重试只会掩盖问题
 *   - 用户主动中断 → 绝不重试
 */

import { ProviderError, statusIsRetryable, RETRYABLE_STATUS } from './types.js'

// 分类判据定义在 types.ts（紧挨着 ProviderError 这个契约），这里再导出一次，
// 让"错误相关的一切"仍然可以从 errors 单点引入
export { RETRYABLE_STATUS, statusIsRetryable }

/** 网络层故障的特征词。SDK 不给你状态码时，只能靠这个兜底 */
const NETWORK_PATTERN =
  /fetch failed|ECONNRESET|ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EPIPE|socket hang up|network|timeout|premature close|terminated|und_err|bad gateway|service unavailable/i

export function isAbortError(err: unknown): err is Error {
  return (
    err instanceof Error &&
    (err.name === 'AbortError' ||
      err.name === 'APIUserAbortError' ||
      err.name === 'ResponseAborted')
  )
}

/** 生成标准的中断错误（sleep 被中断时用） */
export function makeAbortError(): Error {
  const e = new Error('The operation was aborted')
  e.name = 'AbortError'
  return e
}

/**
 * 把任意错误归一化成 ProviderError。
 * 已经是 ProviderError 的原样返回（不重复包装）。
 */
export function toProviderError(err: unknown, fallbackStatus?: number): ProviderError {
  if (err instanceof ProviderError) return err

  if (isAbortError(err)) {
    return new ProviderError(err.message, undefined, false)
  }

  const status = extractStatus(err) ?? fallbackStatus
  const message = err instanceof Error ? err.message : String(err)

  if (status !== undefined) {
    return new ProviderError(message, status, statusIsRetryable(status))
  }

  // 没有状态码：只有能确认是网络层故障才敢重试
  return new ProviderError(message, undefined, NETWORK_PATTERN.test(message))
}

/** 从各家 SDK 的错误对象里抠出状态码 */
function extractStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null) return undefined
  const e = err as Record<string, unknown>
  for (const key of ['status', 'statusCode', 'code', 'response_status']) {
    const v = e[key]
    if (typeof v === 'number' && v >= 100 && v < 600) return v
    if (typeof v === 'string' && /^\d{3}$/.test(v)) return Number(v)
  }
  // 有些 SDK 把状态码藏在 response / error 子对象里
  const nested = e.response ?? e.error
  if (typeof nested === 'object' && nested !== null && nested !== e) {
    return extractStatus(nested)
  }
  return undefined
}

/**
 * 解析 Retry-After 响应头。
 * 两种格式都支持：秒数（`Retry-After: 30`）和 HTTP 日期。
 * 服务端明确告诉你要等多久时，听它的 —— 比自己算的指数退避准。
 */
export function parseRetryAfter(header: string | null | undefined): number | undefined {
  if (!header) return undefined
  const trimmed = header.trim()
  const secs = Number(trimmed)
  if (Number.isFinite(secs) && secs >= 0) return Math.min(secs * 1000, 60_000)
  const date = Date.parse(trimmed)
  if (!Number.isNaN(date)) return Math.min(Math.max(date - Date.now(), 0), 60_000)
  return undefined
}
