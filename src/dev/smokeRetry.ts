/**
 * 冒烟测试 · 重试与退避（withRetry / 错误分类）
 *
 * 重试这块的坑在于「看起来有用，实际是摆设」：
 *   - 该重试的没重试（错误没被正确分类）→ 网络一抖就崩
 *   - 不该重试的乱重试 → 400 请求错误也重试 4 次，白烧钱还拖慢
 *   - 退避不增长 → 一堆客户端同时重试，把刚恢复的服务再打挂（惊群）
 *   - 等待时不能被中断 → 用户按了 Ctrl+C 还得干等 8 秒
 *
 * sleep 和 random 都注入成确定值，所以测试跑得飞快且结果稳定。
 *
 *   npm run smoke:retry
 */

import { ProviderError } from '../api/types.js'
import { parseRetryAfter, toProviderError } from '../api/errors.js'
import { withRetry, backoffDelay, DEFAULT_RETRY_POLICY } from '../core/withRetry.js'
import { ScriptedProvider } from './scriptedModel.js'
import { ToolRegistry } from '../core/tool.js'
import { ReadTool } from '../tools/ReadTool.js'
import { runAgent, findOrphanToolUses, type TurnTrace } from '../core/runAgent.js'
import { createUserMessage, type Message } from '../types/message.js'
import type { ModelProvider, ModelRequest, StreamEvent } from '../api/types.js'

/** 不真等的 sleep：只记录被要求睡了多久 */
function fakeSleep(recorder: number[], signal?: AbortSignal) {
  return async (ms: number) => {
    if (signal?.aborted) throw new Error('aborted')
    recorder.push(ms)
  }
}

/** 一调用就抛指定错误的 provider（可指定第几次开始成功） */
class FlakyProvider implements ModelProvider {
  readonly name = 'flaky'
  calls = 0
  constructor(
    private readonly error: () => Error,
    private readonly failTimes: number,
    private readonly inner: ModelProvider,
  ) {}

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    this.calls += 1
    if (this.calls <= this.failTimes) throw this.error()
    yield* this.inner.stream(req)
  }
}

const noSleep = async () => {}
const fixedRandom = () => 0.5

async function main(): Promise<void> {
  const checks: Array<[string, boolean, string]> = []

  // ── A. 错误分类：该重试的 / 不该重试的 ────────────────────
  {
    const cases: Array<[string, unknown, boolean]> = [
      ['429 限流', new ProviderError('rate limited', 429), true],
      ['529 过载', new ProviderError('overloaded', 529), true],
      ['503 服务不可用', new ProviderError('unavailable', 503), true],
      ['500 服务端错误', new ProviderError('boom', 500), true],
      ['400 请求写错了', new ProviderError('bad request', 400), false],
      ['401 密钥错了', new ProviderError('unauthorized', 401), false],
      ['404 模型不存在', new ProviderError('not found', 404), false],
      ['连接重置', new TypeError('fetch failed'), true],
      ['socket 断开', new Error('socket hang up'), true],
      ['超时', new Error('ETIMEDOUT'), true],
      ['认不出的错误', new Error('something weird'), false],
      ['用户中断', Object.assign(new Error('aborted'), { name: 'AbortError' }), false],
    ]

    let wrong = 0
    for (const [label, err, expected] of cases) {
      const got = toProviderError(err).retryable
      if (got !== expected) {
        wrong += 1
        console.log(`    \x1b[31m${label}：期望 ${expected}，实际 ${got}\x1b[0m`)
      }
    }
    checks.push(['A 12 种错误分类全部正确', wrong === 0, `${cases.length - wrong}/${cases.length}`])

    // SDK 把状态码藏在对象里也要能抠出来
    checks.push([
      'A 能抠出嵌套的 status',
      toProviderError({ status: 429, message: 'x' }).retryable === true,
      'SDK 形状各异',
    ])
    checks.push([
      'A 已是 ProviderError 时不重复包装',
      (() => {
        const e = new ProviderError('x', 500, true)
        return toProviderError(e) === e
      })(),
      '原样返回',
    ])
  }

  // ── B. 指数退避真的在增长，且封顶 ─────────────────────────
  {
    // random=0 → delay = raw/2，拿到确定的下界序列
    const seq = [1, 2, 3, 4, 5].map((n) => backoffDelay(n, DEFAULT_RETRY_POLICY, () => 0))
    checks.push([
      'B 退避指数增长',
      seq[0] === 250 && seq[1] === 500 && seq[2] === 1000,
      seq.slice(0, 3).join(' → ') + ' ms',
    ])
    checks.push([
      'B 退避有上限（不超过 8s）',
      backoffDelay(20, DEFAULT_RETRY_POLICY, () => 1) <= DEFAULT_RETRY_POLICY.maxDelayMs,
      `${backoffDelay(20, DEFAULT_RETRY_POLICY, () => 1)}ms`,
    ])
    // 抖动：同一个 attempt，不同 random 得到不同延迟（打散惊群）
    const a = backoffDelay(3, DEFAULT_RETRY_POLICY, () => 0)
    const b = backoffDelay(3, DEFAULT_RETRY_POLICY, () => 1)
    checks.push(['B 抖动在起作用', a !== b && a === 1000 && b === 2000, `${a} ~ ${b} ms`])
  }

  // ── C. 重试到底：第 3 次成功 ──────────────────────────────
  {
    const delays: number[] = []
    let attempts = 0
    const result = await withRetry(
      async (attempt) => {
        attempts = attempt
        if (attempt < 2) throw new ProviderError('overloaded', 529)
        return 'ok'
      },
      { sleep: fakeSleep(delays), random: fixedRandom },
    )

    checks.push(['C 第 3 次尝试成功', result === 'ok' && attempts === 2, `attempt=${attempts}`])
    checks.push(['C 重试了 2 次', delays.length === 2, `等了 ${delays.join(' + ')}ms`])
    checks.push(['C 等待时长递增', delays[1]! > delays[0]!, delays.join(' → ') + ' ms'])
  }

  // ── D. 不可重试 → 立刻失败，一次都不重试 ──────────────────
  {
    const delays: number[] = []
    let threw: unknown
    try {
      await withRetry(
        async () => {
          throw new ProviderError('bad request', 400)
        },
        { sleep: fakeSleep(delays), random: fixedRandom },
      )
    } catch (err) {
      threw = err
    }
    checks.push(['D 400 一次都不重试', delays.length === 0, `等了 ${delays.length} 次`])
    checks.push(['D 错误原样抛出', threw instanceof ProviderError && threw.status === 400, '未吞掉错误'])
  }

  // ── E. 次数用尽 → 抛出最后一次的错误 ──────────────────────
  {
    const delays: number[] = []
    let threw: unknown
    try {
      await withRetry(
        async () => {
          throw new ProviderError('still broken', 503)
        },
        { maxRetries: 2, sleep: fakeSleep(delays), random: fixedRandom },
      )
    } catch (err) {
      threw = err
    }
    checks.push(['E 重试到次数用尽就停', delays.length === 2, `重试 ${delays.length} 次后放弃`])
    checks.push(['E 抛出原始错误', threw instanceof ProviderError, '不是包装过的'])
  }

  // ── F. 听服务端的 Retry-After ─────────────────────────────
  {
    const delays: number[] = []
    await withRetry(
      async (attempt) => {
        if (attempt === 0) throw new ProviderError('rate limited', 429, true, 5000)
        return 'ok'
      },
      { sleep: fakeSleep(delays), random: fixedRandom },
    )
    checks.push([
      'F Retry-After 优先于自己算的退避',
      delays[0] === 5000,
      `等了 ${delays[0]}ms（自己算只需 250~500ms）`,
    ])
    checks.push([
      'F Retry-After 头解析正确',
      parseRetryAfter('30') === 30_000 && parseRetryAfter('Wed, 21 Oct 2026 07:28:00 GMT') !== undefined,
      '秒数与日期两种格式',
    ])
  }

  // ── G. 总预算：不能无限等下去 ─────────────────────────────
  {
    const delays: number[] = []
    try {
      await withRetry(
        async () => {
          throw new ProviderError('always down', 503)
        },
        { maxRetries: 10, maxTotalDelayMs: 2000, sleep: fakeSleep(delays), random: () => 1 },
      )
    } catch {
      /* 预期失败 */
    }
    const total = delays.reduce((s, d) => s + d, 0)
    checks.push(['G 累计等待不超预算', total <= 2000, `累计 ${total}ms / 预算 2000ms`])
    checks.push(['G 提前放弃而不是死等', delays.length < 10, `只试了 ${delays.length} 次`])
  }

  // ── H. 中断：等待中按 Ctrl+C 要立刻放弃 ───────────────────
  {
    const controller = new AbortController()
    let threw: unknown
    try {
      await withRetry(
        async () => {
          controller.abort()
          throw new ProviderError('overloaded', 529)
        },
        { signal: controller.signal, sleep: noSleep, random: fixedRandom },
      )
    } catch (err) {
      threw = err
    }
    checks.push(['H 已中断就不重试', threw instanceof ProviderError, '立刻放弃'])

    // 等待期间被中断：sleep 必须感知 signal
    const c2 = new AbortController()
    let sleepAborted = false
    try {
      await withRetry(
        async () => {
          throw new ProviderError('overloaded', 529)
        },
        {
          signal: c2.signal,
          random: fixedRandom,
          sleep: async () => {
            c2.abort()
            if (c2.signal.aborted) {
              sleepAborted = true
              throw Object.assign(new Error('aborted'), { name: 'AbortError' })
            }
          },
        },
      )
    } catch {
      /* 预期 */
    }
    checks.push(['H 等待期间可被打断', sleepAborted, '用户不用干等'])
  }

  // ── I. 接进主循环：前 2 次失败，第 3 次成功 ───────────────
  {
    const traces: TurnTrace[] = []
    const retries: number[] = []
    const inner = new ScriptedProvider([
      { blocks: [{ type: 'text', text: '读完了，这是个 agent runtime 项目。' }] },
    ])
    const flaky = new FlakyProvider(() => new ProviderError('overloaded', 529), 2, inner)

    const messages: Message[] = [createUserMessage('这是个什么项目？')]
    const r = await runAgent({
      provider: flaky,
      model: 'scripted-1',
      system: '',
      tools: new ToolRegistry().register(ReadTool),
      messages,
      tracer: { onTurn: (t) => traces.push(t) },
      retry: { maxRetries: 3, baseDelayMs: 1, sleep: noSleep, random: fixedRandom },
      onRetry: (info) => retries.push(info.attempt),
    })

    checks.push(['I 抖动后任务照样完成', r.stopReason === 'end_turn', r.stopReason])
    checks.push(['I 模型被调用了 3 次', flaky.calls === 3, `${flaky.calls} 次`])
    checks.push(['I 重试次数记进 Trace', traces[0]!.retries === 2, `retries=${traces[0]!.retries}`])
    checks.push(['I onRetry 回调了 2 次', retries.length === 2, retries.join(',')])
    checks.push(['I 无孤儿 tool_use', findOrphanToolUses(messages).length === 0, '配对完整'])
  }

  // ── J. 重试也救不回来 → 干净失败，不留半截消息 ────────────
  {
    const inner = new ScriptedProvider([{ blocks: [{ type: 'text', text: 'x' }] }])
    const alwaysDown = new FlakyProvider(() => new ProviderError('bad request', 400), 99, inner)
    const messages: Message[] = [createUserMessage('hi')]

    const r = await runAgent({
      provider: alwaysDown,
      model: 'scripted-1',
      system: '',
      tools: new ToolRegistry().register(ReadTool),
      messages,
      retry: { maxRetries: 3, baseDelayMs: 1, sleep: noSleep, random: fixedRandom },
    })

    checks.push(['J 400 不重试（只调用 1 次）', alwaysDown.calls === 1, `${alwaysDown.calls} 次`])
    checks.push(['J 返回 error 而不是崩', r.stopReason === 'error' && !!r.error, r.stopReason])
    checks.push(['J 历史里没留半截消息', messages.length === 1, `${messages.length} 条`])
  }

  // ── 输出 ──────────────────────────────────────────────────
  console.log('\n  冒烟测试 —— 重试与退避\n')
  let failed = 0
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}  \x1b[2m${detail}\x1b[0m`)
    if (!ok) failed += 1
  }

  console.log(
    failed === 0
      ? '\n  \x1b[32m全部通过。该重试的重试、不该重试的立刻放弃、等得起也停得住。\x1b[0m\n'
      : `\n  \x1b[31m${failed} 项失败\x1b[0m\n`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
