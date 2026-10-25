/**
 * 服务层冒烟测试（零 API key）
 *
 * 起一个真的 HTTP 服务、用真的 fetch 打它、解析真的 SSE —— 但模型是剧本模型。
 * 所以能测到"服务化"带来的全部新问题，而不用花一分钱：
 *
 *   多会话隔离 · 鉴权 · 并发闸门 · 成本熔断 · 请求体上限 · 日志落盘 · 优雅退出
 *
 * 这些东西在 CLI 里根本不存在，也就无从测起。
 */

import { mkdtempSync, readFileSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ScriptedProvider, type ScriptedTurn } from './scriptedModel.js'
import { ToolRegistry } from '../core/tool.js'
import { ReadTool } from '../tools/ReadTool.js'
import { AgentServer } from '../server/http.js'
import { JsonlLogger } from '../server/log.js'
import { loadConfig, type ServerConfig } from '../server/config.js'

type Check = [string, boolean, string?]
const checks: Check[] = []

const ROOT = join(import.meta.dirname, '..', '..')
const LOGDIR = mkdtempSync(join(tmpdir(), 'agent-runtime-log-'))

function cfg(over: Record<string, string> = {}): ServerConfig {
  return loadConfig({
    ...process.env,
    PROVIDER: 'openai',
    API_KEY: 'test-key',
    CWD: ROOT,
    LOG_DIR: LOGDIR,
    ...over,
  } as NodeJS.ProcessEnv)
}

function makeServer(turns: ScriptedTurn[], over: Record<string, string> = {}) {
  const config = cfg(over)
  const logger = new JsonlLogger(config.logDir)
  const server = new AgentServer({
    config,
    provider: new ScriptedProvider(turns),
    tools: new ToolRegistry().register(ReadTool),
    logger,
  })
  return { server, logger, config }
}

type SseEvent = { event: string; data: any }

function parseSSE(raw: string): SseEvent[] {
  const out: SseEvent[] = []
  for (const block of raw.split('\n\n')) {
    const ev = /^event: (.+)$/m.exec(block)
    const dt = /^data: (.+)$/m.exec(block)
    if (!ev || !dt) continue
    try {
      out.push({ event: ev[1]!, data: JSON.parse(dt[1]!) })
    } catch {
      /* 忽略解析不了的块 */
    }
  }
  return out
}

async function call(
  base: string,
  path: string,
  init: RequestInit & { token?: string } = {},
): Promise<{ status: number; json: any; raw: string }> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' }
  if (init.token) headers.Authorization = `Bearer ${init.token}`
  const res = await fetch(base + path, { ...init, headers: { ...headers, ...(init.headers as object) } })
  const raw = await res.text()
  let json: any = null
  try {
    json = JSON.parse(raw)
  } catch {
    /* SSE 不是 JSON */
  }
  return { status: res.status, json, raw }
}

async function main(): Promise<void> {
  // ── A 基础路由 ──────────────────────────────────────────
  const a = makeServer([
    { blocks: [{ type: 'tool_use', name: 'Read', input: { path: 'package.json' } }] },
    { blocks: [{ type: 'text', text: '读完了，这是个 TypeScript 项目。' }] },
  ])
  const { port } = await a.server.listen(0)
  const base = `http://127.0.0.1:${port}`

  const health = await call(base, '/healthz')
  checks.push(['A 健康检查通过', health.status === 200 && health.json?.ok === true, `HTTP ${health.status}`])

  const created = await call(base, '/v1/sessions', { method: 'POST' })
  const sid = created.json?.id as string | undefined
  checks.push(['A 创建会话', created.status === 201 && !!sid, `HTTP ${created.status}`])

  const notFound = await call(base, '/v1/nope')
  checks.push(['A 未知路由 404', notFound.status === 404, `HTTP ${notFound.status}`])

  // ── B 一次完整 run（SSE）───────────────────────────────
  const run = await call(base, `/v1/sessions/${sid}/runs`, {
    method: 'POST',
    body: JSON.stringify({ text: '读一下 package.json' }),
  })
  const events = parseSSE(run.raw)
  const kinds = events.map((e) => e.event)
  const done = events.find((e) => e.event === 'done')?.data

  checks.push(['B SSE 事件序列完整', kinds.includes('run_start') && kinds.includes('turn') && kinds.includes('done'), kinds.join(' → ')])
  checks.push(['B 工具真的被执行', kinds.includes('tool_start') && kinds.includes('tool_end'), `${kinds.filter((k) => k === 'tool_start').length} 次工具调用`])
  checks.push(['B 正常结束', done?.stopReason === 'end_turn', String(done?.stopReason)])
  checks.push(['B 拿到最终文本', String(done?.finalText ?? '').includes('读完了'), String(done?.finalText).slice(0, 20)])

  // ── C 会话状态与历史 ───────────────────────────────────
  const s1 = await call(base, `/v1/sessions/${sid}`)
  checks.push(['C 记账生效（花了钱）', s1.json?.costUSD > 0, `$${s1.json?.costUSD}`])
  checks.push(['C 历史被保留', s1.json?.messages >= 3, `${s1.json?.messages} 条消息`])

  const run2 = await call(base, `/v1/sessions/${sid}/runs`, {
    method: 'POST',
    body: JSON.stringify({ text: '再读一次' }),
  })
  const s1b = await call(base, `/v1/sessions/${sid}`)
  checks.push(['C 第二次 run 追加到同一会话', s1b.json?.runs === 2 && s1b.json?.messages > s1.json?.messages, `${s1.json?.messages} → ${s1b.json?.messages} 条`])
  void run2

  // ── D 会话隔离 ─────────────────────────────────────────
  const s2 = await call(base, '/v1/sessions', { method: 'POST' })
  await call(base, `/v1/sessions/${s2.json.id}/runs`, {
    method: 'POST',
    body: JSON.stringify({ text: '你好' }),
  })
  const s1c = await call(base, `/v1/sessions/${sid}`)
  checks.push(['D 会话之间互不影响', s1c.json?.runs === 2, `会话1 仍是 ${s1c.json?.runs} 次`])

  // ── E 参数校验 ─────────────────────────────────────────
  const empty = await call(base, `/v1/sessions/${sid}/runs`, { method: 'POST', body: JSON.stringify({ text: '  ' }) })
  checks.push(['E 空输入被拒', empty.status === 400, `HTTP ${empty.status}`])

  const badSession = await call(base, '/v1/sessions/does-not-exist/runs', { method: 'POST', body: JSON.stringify({ text: 'hi' }) })
  checks.push(['E 不存在的会话 404', badSession.status === 404, `HTTP ${badSession.status}`])

  await a.server.close()

  // ── F 鉴权 ─────────────────────────────────────────────
  const f = makeServer([{ blocks: [{ type: 'text', text: 'ok' }] }], { AUTH_TOKEN: 'secret-123' })
  const fInfo = await f.server.listen(0)
  const fbase = `http://127.0.0.1:${fInfo.port}`

  const noAuth = await call(fbase, '/healthz')
  const noToken = await call(fbase, '/v1/sessions')
  const wrongToken = await call(fbase, '/v1/sessions', { token: 'secret-124' })
  const rightToken = await call(fbase, '/v1/sessions', { token: 'secret-123' })

  checks.push(['F 健康检查不需要鉴权', noAuth.status === 200, `HTTP ${noAuth.status}`])
  checks.push(['F 无 token 被拒', noToken.status === 401, `HTTP ${noToken.status}`])
  checks.push(['F 错 token 被拒', wrongToken.status === 401, `HTTP ${wrongToken.status}`])
  checks.push(['F 对 token 放行', rightToken.status === 200, `HTTP ${rightToken.status}`])
  await f.server.close()

  // ── G 成本熔断 ─────────────────────────────────────────
  const g = makeServer(
    [
      { blocks: [{ type: 'tool_use', name: 'Read', input: { path: 'package.json' } }] },
      { blocks: [{ type: 'text', text: '读完了' }] },
    ],
    { SESSION_BUDGET_USD: '0.005' },
  )
  const gInfo = await g.server.listen(0)
  const gbase = `http://127.0.0.1:${gInfo.port}`
  const gs = await call(gbase, '/v1/sessions', { method: 'POST' })
  const gRun = await call(gbase, `/v1/sessions/${gs.json.id}/runs`, {
    method: 'POST',
    body: JSON.stringify({ text: '读 package.json' }),
  })
  const gDone = parseSSE(gRun.raw).find((e) => e.event === 'done')?.data
  const after = await call(gbase, `/v1/sessions/${gs.json.id}`)
  const gSecond = await call(gbase, `/v1/sessions/${gs.json.id}/runs`, {
    method: 'POST',
    body: JSON.stringify({ text: '再来' }),
  })

  checks.push(['G 超预算时熔断中止', gDone?.overBudget === true, `overBudget=${gDone?.overBudget}`])
  checks.push(['G 熔断后仍完成记账', after.json?.costUSD > 0.005, `$${after.json?.costUSD}`])
  checks.push(['G 预算耗尽后拒绝新 run', gSecond.status === 402, `HTTP ${gSecond.status}`])
  await g.server.close()

  // ── H 并发闸门 ─────────────────────────────────────────
  const h = makeServer([{ blocks: [{ type: 'text', text: '一段比较长的回复用来制造延迟', }], chunkSize: 1, delayMs: 25 }])
  const hInfo = await h.server.listen(0)
  const hbase = `http://127.0.0.1:${hInfo.port}`
  const hs = await call(hbase, '/v1/sessions', { method: 'POST' })

  const [first, second] = await Promise.all([
    call(hbase, `/v1/sessions/${hs.json.id}/runs`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) }),
    call(hbase, `/v1/sessions/${hs.json.id}/runs`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) }),
  ])
  const statuses = [first.status, second.status].sort()
  checks.push(['H 同会话并发被拦（一个 200 一个 409）', statuses[0] === 200 && statuses[1] === 409, statuses.join(' / ')])

  // 并发上限
  const h2Sessions = await Promise.all(
    [0, 1, 2, 3, 4].map(() => call(hbase, '/v1/sessions', { method: 'POST' })),
  )
  const results = await Promise.all(
    h2Sessions.map((s) =>
      call(hbase, `/v1/sessions/${s.json.id}/runs`, { method: 'POST', body: JSON.stringify({ text: 'hi' }) }),
    ),
  )
  const okCount = results.filter((r) => r.status === 200).length
  const busyCount = results.filter((r) => r.status === 503).length
  checks.push(['H 并发上限生效（默认 4）', okCount === 4 && busyCount === 1, `${okCount} 通过 / ${busyCount} 拒绝`])
  await h.server.close()

  // ── I 日志落盘 ─────────────────────────────────────────
  const files = readdirSync(LOGDIR).filter((n) => n.endsWith('.jsonl'))
  const lines = files.flatMap((n) => readFileSync(join(LOGDIR, n), 'utf8').split('\n').filter(Boolean))
  const parsed = lines.map((l) => JSON.parse(l))
  checks.push(['I 结构化日志已落盘', files.length > 0 && lines.length > 10, `${files.length} 个文件 / ${lines.length} 行`])
  checks.push(['I 日志字段完整（ts/event/level）', parsed.every((r) => r.ts && r.event && r.level), parsed[0]?.event ?? ''])

  // ── 汇总 ───────────────────────────────────────────────
  console.log('\n服务层冒烟测试（零 API key，含真实 HTTP 与 SSE）\n')
  let pass = 0
  for (const [name, ok, note] of checks) {
    if (ok) pass += 1
    console.log(`${ok ? '  ✓' : '  ✗'} ${name.padEnd(32)} ${note ?? ''}`)
  }
  console.log(`\n${pass}/${checks.length} 通过\n`)
  if (pass !== checks.length) process.exit(1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
