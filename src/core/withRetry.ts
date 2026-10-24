/**
 * withRetry —— 指数退避重试
 *
 * 为什么必须有：真实网络一定会抖。限流（429）、服务端过载（529）、
 * 连接重置，这些都是**正常现象**而不是错误。一次抖动就让整个任务崩掉，
 * 用户体验是"这东西不靠谱"。
 *
 * 四个必须做对的地方：
 *
 *  1. 【不是所有错误都该重试】
 *     400 是请求写错了，重试一百次还是错的，只会白白烧钱。
 *     认不出来的错误也**不重试** —— 可能是我们的 bug，盲目重试会掩盖问题。
 *     只有"明确的服务端临时故障"和"明确的网络层故障"才重试。
 *
 *  2. 【退避必须指数增长 + 抖动】
 *     固定间隔重试会造成"惊群"：所有客户端同时失败、同时重试、再次同时被打回。
 *     指数增长把重试摊开，抖动（jitter）打散不同客户端的相位。
 *     这里用 equal jitter：delay = raw/2 + random(0, raw/2)。
 *     纯随机（full jitter）理论上最优，但可能算出接近 0 的等待；
 *     留一半保底更稳。
 *
 *  3. 【服务端说了算】
 *     响应带 Retry-After 时听它的。服务端比我们清楚自己什么时候能恢复，
 *     自己算的指数退避在限流场景下往往太激进。
 *
 *  4. 【等待期间要能被中断】
 *     退避最长可能几十秒。用户按 Ctrl+C 之后还要干等，是不可接受的。
 *     所以 sleep 自带 signal，一中断立刻抛。
 *
 *  另外设了 maxTotalDelayMs 总预算：重试是为了扛抖动，不是为了死等。
 *  一个已经等了 60 秒还没成功的请求，再多试一次意义不大。
 */

import type { ProviderError } from '../api/types.js'
import { isAbortError, makeAbortError, toProviderError } from '../api/errors.js'

export interface RetryPolicy {
  /** 最多重试几次（不含首次）。默认 3 */
  maxRetries: number
  /** 首次退避基数。默认 500ms */
  baseDelayMs: number
  /** 单次退避上限。默认 8000ms */
  maxDelayMs: number
  /** 累计等待总预算，超了就不再试。默认 30000ms */
  maxTotalDelayMs: number
  /** 注入 sleep —— 测试里换成不真等的版本 */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** 注入随机源 —— 测试里固定住才能得到确定的延迟序列 */
  random?: () => number
  signal?: AbortSignal
  /** 每次决定重试时回调。UI 显示"网络抖动，第 2 次重试…"，Trace 记重试次数 */
  onRetry?: (info: RetryInfo) => void
}

export interface RetryInfo {
  /** 第几次重试（1 起） */
  attempt: number
  error: ProviderError
  delayMs: number
  /** 已经累计等待了多久 */
  totalDelayMs: number
  willRetry: boolean
}

export const DEFAULT_RETRY_POLICY: Omit<RetryPolicy, 'signal' | 'onRetry'> = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 8_000,
  maxTotalDelayMs: 30_000,
}

/**
 * 执行 fn，失败且可重试时按指数退避重来。
 *
 * fn 收到一个 0 起的 attempt 序号（第几次尝试），便于日志。
 * 不可重试 / 次数用尽 / 预算耗尽 / 被中断，都会原样抛出最后一次的错误。
 */
export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  policy: Partial<RetryPolicy> = {},
): Promise<T> {
  const p: RetryPolicy = { ...DEFAULT_RETRY_POLICY, ...policy }
  const sleep = p.sleep ?? defaultSleep
  const random = p.random ?? Math.random

  let totalDelayMs = 0
  let attempt = 0

  for (;;) {
    try {
      return await fn(attempt)
    } catch (rawErr) {
      const err = toProviderError(rawErr)

      // 用户主动中断：立刻放弃，不重试也不回调
      if (p.signal?.aborted || isAbortError(rawErr)) throw rawErr

      attempt += 1
      const willRetry =
        err.retryable && attempt <= p.maxRetries

      if (!willRetry) {
        p.onRetry?.({ attempt, error: err, delayMs: 0, totalDelayMs, willRetry: false })
        throw rawErr
      }

      // 服务端给了 Retry-After 就听它的；否则指数增长 + 抖动
      const raw = Math.min(p.maxDelayMs, p.baseDelayMs * 2 ** (attempt - 1))
      const jittered = Math.round(raw / 2 + random() * (raw / 2))
      const delayMs = Math.max(jittered, err.retryAfterMs ?? 0)

      // 总预算：超了就认输，不再让用户体验"卡住不动"
      if (totalDelayMs + delayMs > p.maxTotalDelayMs) {
        p.onRetry?.({ attempt, error: err, delayMs: 0, totalDelayMs, willRetry: false })
        throw rawErr
      }

      p.onRetry?.({ attempt, error: err, delayMs, totalDelayMs, willRetry: true })
      await sleep(delayMs, p.signal)
      totalDelayMs += delayMs
    }
  }
}

/** 默认 sleep：可被 signal 中断，且不留下野定时器 */
export function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(makeAbortError())
      return
    }

    const onAbort = () => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      reject(makeAbortError())
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)

    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * 计算第 n 次重试的退避时长（不含服务端 Retry-After）。
 * 单独导出是为了让测试能直接断言延迟序列，而不必真的去等。
 */
export function backoffDelay(
  attempt: number,
  policy: Pick<RetryPolicy, 'baseDelayMs' | 'maxDelayMs'> = DEFAULT_RETRY_POLICY,
  random: () => number = () => 0.5,
): number {
  const raw = Math.min(policy.maxDelayMs, policy.baseDelayMs * 2 ** (attempt - 1))
  return Math.round(raw / 2 + random() * (raw / 2))
}
