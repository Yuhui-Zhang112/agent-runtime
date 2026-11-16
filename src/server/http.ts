/**
 * HTTP 服务层
 *
 * 把 CLI 变成别人能调用的服务。相比 CLI，多了五样东西 —— **每一样都是被
 * 生产环境逼出来的，不是设计出来的**：
 *
 *  1. 【多会话】CLI 只有一条消息历史；服务要同时服务多个会话，彼此隔离。
 *  2. 【鉴权】谁都能调 = 谁都能花你的钱、读你的文件。
 *  3. 【并发闸门】不设上限，几个并发请求就能把进程拖垮。
 *  4. 【成本熔断】模型调用花钱。跑着跑着超预算要能自己停下来，
 *     而不是等账单来了才发现。
 *  5. 【优雅退出】直接 kill 会丢掉正在跑的任务和没落盘的日志。
 *     收到 SIGTERM 后先停止接新活，等手上的干完再走。
 *
 * 关于流式：目前是**轮次级** SSE（每一轮结束推一条 trace），不是 token 级。
 * 因为 runAgent 现在只在结束时给出完整文本，token 级需要把 callModel 的
 * 增量透出来 —— 那是独立的改造，先不混在这里做。
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'

import { runAgent, type TurnTrace } from '../core/runAgent.js'
import { TraceStore } from '../core/traceStore.js'
import type { CompactionEvent } from '../core/compaction.js'
import type { ToolRegistry } from '../core/tool.js'
import type { PermissionEngine } from '../core/permissions.js'
import type { ModelProvider } from '../api/types.js'
import { createUserMessage, createUuid } from '../types/message.js'
import { SessionStore, summarize } from './session.js'
import { JsonlLogger, clip } from './log.js'
import { ApprovalQueue } from './approvals.js'
import type { ServerConfig } from './config.js'

export interface ServerDeps {
  config: ServerConfig
  provider: ModelProvider
  tools: ToolRegistry
  logger: JsonlLogger
  /** 可选注入：不传 = Phase 1 行为，老调用方（含全部旧测试）零改动 */
  permissions?: PermissionEngine
  approvals?: ApprovalQueue
}

export interface ListenInfo {
  port: number
  host: string
}

export class AgentServer {
  private readonly cfg: ServerConfig
  private readonly provider: ModelProvider
  private readonly tools: ToolRegistry
  private readonly logger: JsonlLogger
  private readonly permissions?: PermissionEngine
  private readonly approvals?: ApprovalQueue
  private readonly sessions = new SessionStore()
  /** 当前活跃的 SSE 连接。权限事件广播给它们（同一进程内，多个 run 会同时收到） */
  private readonly sseSinks = new Set<(event: string, data: unknown) => void>()
  private readonly server = createServer((req, res) => {
    void this.handle(req, res)
  })

  /** 当前正在跑的 run 数 */
  private active = 0
  private shuttingDown = false

  constructor(deps: ServerDeps) {
    this.cfg = deps.config
    this.provider = deps.provider
    this.tools = deps.tools
    this.logger = deps.logger
    this.permissions = deps.permissions
    this.approvals = deps.approvals

    // 把权限裁决接进 SSE 与结构化日志：模型每一次"试探边界"都留痕。
    this.permissions?.setDecisionListener((d) => {
      const payload = {
        tool: d.toolName,
        target: d.target,
        final: d.final,
        reason: d.reason,
        asked: d.asked,
        timedOut: d.timedOut,
      }
      this.logger.info('permission', payload)
      this.broadcast('permission', payload)
    })
    if (this.approvals) {
      this.approvals.onRequest = (a) => this.broadcast('permission_request', a)
      this.approvals.onResolved = (id, decision) =>
        this.broadcast('permission_resolved', { id, decision })
    }
  }

  /** port 传 0 = 让系统分配空闲端口（测试用） */
  async listen(port = this.cfg.port, host = this.cfg.host): Promise<ListenInfo> {
    await new Promise<void>((resolve, reject) => {
      this.server.once('error', reject)
      this.server.listen(port, host, resolve)
    })
    const addr = this.server.address() as AddressInfo | null
    this.logger.info('server_listen', { port: addr?.port, host, auth: this.cfg.authToken !== null })
    return { port: addr?.port ?? port, host }
  }

  /** 优雅退出：停止接新请求 → 等在跑的结束（有上限）→ 关闭监听 */
  async close(waitMs = 10_000): Promise<void> {
    this.shuttingDown = true
    // 挂着的审批一律拒绝，否则在跑的 run 会永远等下去
    const rejected = this.approvals?.rejectAll() ?? 0
    if (rejected > 0) this.logger.warn('approvals_rejected_on_close', { count: rejected })
    const deadline = Date.now() + waitMs
    while (this.active > 0 && Date.now() < deadline) {
      await sleep(50)
    }
    if (this.active > 0) {
      this.logger.warn('close_forced', { stillActive: this.active })
    }
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
    this.logger.info('server_closed', {})
  }

  get sessionStore(): SessionStore {
    return this.sessions
  }

  private broadcast(event: string, data: unknown): void {
    for (const sink of this.sseSinks) sink(event, data)
  }

  // ── 路由 ──────────────────────────────────────────────────

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`)
    const path = url.pathname
    const method = req.method ?? 'GET'

    // 健康检查不鉴权：负载均衡器要能随时探活
    if (method === 'GET' && path === '/healthz') {
      return sendJson(res, 200, {
        ok: !this.shuttingDown,
        active: this.active,
        sessions: this.sessions.list().length,
        shuttingDown: this.shuttingDown,
      })
    }

    if (!this.authorized(req)) {
      return sendJson(res, 401, { error: '缺少或错误的 Authorization 头' })
    }
    if (this.shuttingDown) {
      return sendJson(res, 503, { error: '服务正在关闭' })
    }

    try {
      if (method === 'GET' && path === '/v1/tools') {
        return sendJson(res, 200, { tools: this.tools.specs() })
      }

      // ── Phase 3：当前压缩策略（运维/看板查询用，不暴露历史内容）──
      if (method === 'GET' && path === '/v1/compaction') {
        return sendJson(res, 200, {
          enabled: this.cfg.compaction !== null,
          policy: this.cfg.compaction,
          traceDir: this.cfg.traceDir,
        })
      }

      // ── Phase 2：权限状态、规则、审批 ──────────────────────
      if (method === 'GET' && path === '/v1/permissions') {
        return sendJson(
          res,
          200,
          this.permissions
            ? {
                enabled: true,
                ...this.permissions.describe(),
                pending: this.approvals?.list() ?? [],
              }
            : { enabled: false },
        )
      }

      if (method === 'POST' && path === '/v1/permissions/rules') {
        if (!this.permissions) return sendJson(res, 404, { error: '权限系统未启用' })
        let body: unknown
        try {
          body = await readJsonBody(req, this.cfg.maxBodyBytes)
        } catch (err) {
          return sendJson(res, 400, { error: String(err instanceof Error ? err.message : err) })
        }
        const b = (body ?? {}) as Record<string, unknown>
        if (
          typeof b.tool !== 'string' ||
          b.tool.trim() === '' ||
          (b.action !== 'allow' && b.action !== 'deny' && b.action !== 'ask')
        ) {
          return sendJson(res, 400, { error: '需要 tool: string 与 action: allow | deny | ask' })
        }
        if (b.pattern !== undefined && typeof b.pattern !== 'string') {
          return sendJson(res, 400, { error: 'pattern 必须是字符串' })
        }
        const rule = {
          tool: b.tool,
          action: b.action as 'allow' | 'deny' | 'ask',
          ...(typeof b.pattern === 'string' ? { pattern: b.pattern } : {}),
        }
        this.permissions.addRule(rule)
        this.logger.info('permission_rule_added', rule)
        return sendJson(res, 201, { rule, rules: this.permissions.listRules() })
      }

      if (method === 'POST' && path === '/v1/approvals') {
        let body: unknown
        try {
          body = await readJsonBody(req, this.cfg.maxBodyBytes)
        } catch (err) {
          return sendJson(res, 400, { error: String(err instanceof Error ? err.message : err) })
        }
        const b = (body ?? {}) as Record<string, unknown>
        if (
          typeof b.id !== 'string' ||
          b.id === '' ||
          (b.decision !== 'allow' && b.decision !== 'deny' && b.decision !== 'always')
        ) {
          return sendJson(res, 400, { error: '需要 id 与 decision: allow | deny | always' })
        }
        const ok = this.approvals?.resolve(b.id, b.decision) ?? false
        this.logger.info('approval_resolved', { id: b.id, decision: b.decision, ok })
        return ok
          ? sendJson(res, 200, { resolved: b.id, decision: b.decision })
          : sendJson(res, 404, { error: '审批请求不存在或已超时' })
      }

      if (method === 'POST' && path === '/v1/sessions') {
        const s = this.sessions.create()
        this.logger.info('session_create', { sessionId: s.id })
        return sendJson(res, 201, summarize(s))
      }

      if (method === 'GET' && path === '/v1/sessions') {
        return sendJson(res, 200, { sessions: this.sessions.list() })
      }

      const m = /^\/v1\/sessions\/([^/]+)$/.exec(path)
      if (m) {
        const id = decodeURIComponent(m[1]!)
        if (method === 'GET') {
          const s = this.sessions.get(id)
          return s ? sendJson(res, 200, summarize(s)) : sendJson(res, 404, { error: '会话不存在' })
        }
        if (method === 'DELETE') {
          const ok = this.sessions.delete(id)
          return ok
            ? sendJson(res, 200, { deleted: id })
            : sendJson(res, 409, { error: '会话不存在或正在执行中' })
        }
      }

      const rm = /^\/v1\/sessions\/([^/]+)\/runs$/.exec(path)
      if (rm && method === 'POST') {
        return this.runStream(req, res, decodeURIComponent(rm[1]!))
      }

      return sendJson(res, 404, { error: `未知路由 ${method} ${path}` })
    } catch (err) {
      this.logger.error('handler_error', { error: String(err), path })
      return sendJson(res, 500, { error: '内部错误' })
    }
  }

  // ── 执行一次 run，用 SSE 推事件 ────────────────────────────

  private async runStream(req: IncomingMessage, res: ServerResponse, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId)
    if (!session) return sendJson(res, 404, { error: '会话不存在' })

    if (session.costUSD >= this.cfg.sessionBudgetUSD) {
      return sendJson(res, 402, {
        error: '该会话已超出成本上限',
        costUSD: session.costUSD,
        budgetUSD: this.cfg.sessionBudgetUSD,
      })
    }

    // 同会话串行：见 session.ts 文件头第 2 条
    if (!this.sessions.acquire(sessionId)) {
      return sendJson(res, 409, { error: '该会话正在执行中，请稍后再试' })
    }
    if (this.active >= this.cfg.maxConcurrentRuns) {
      this.sessions.release(sessionId)
      return sendJson(res, 503, { error: '并发任务已满，请稍后再试' })
    }

    let body: unknown
    try {
      body = await readJsonBody(req, this.cfg.maxBodyBytes)
    } catch (err) {
      this.sessions.release(sessionId)
      return sendJson(res, 400, { error: String(err instanceof Error ? err.message : err) })
    }

    const text = typeof (body as { text?: unknown })?.text === 'string' ? (body as { text: string }).text : ''
    if (!text.trim()) {
      this.sessions.release(sessionId)
      return sendJson(res, 400, { error: '请求体需要 text 字段' })
    }

    this.active += 1
    const runId = createUuid()
    const log = this.logger.child({ sessionId, runId })
    // Phase 3：每轮 Trace 落盘，进程重启后仍可回放（Eval / 看板的数据源）
    const traceStore = new TraceStore(this.cfg.traceDir, runId)
    const controller = new AbortController()
    // 客户端断开就中止 —— 否则模型还在跑、钱还在烧
    req.on('close', () => controller.abort())

    let ended = false
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      // 关掉 Nginx 缓冲，否则事件会被攒着一起发
      'X-Accel-Buffering': 'no',
    })
    const sse = (event: string, data: unknown): void => {
      if (ended) return
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
    }
    // 这个 run 期间接收权限事件（审批请求、裁决结果）
    this.sseSinks.add(sse)

    log.info('run_start', { text: clip(text) })
    sse('run_start', { runId, sessionId })

    session.messages.push(createUserMessage(text, session.messages.at(-1)?.uuid ?? null))

    let spent = 0
    let overBudget = false

    try {
      const result = await runAgent({
        provider: this.provider,
        model: this.cfg.model,
        system: this.cfg.system,
        tools: this.tools,
        permissions: this.permissions,
        compaction: this.cfg.compaction,
        onCompaction: (e: CompactionEvent) => {
          sse('compaction', {
            turn: e.turn,
            applied: e.applied,
            reason: e.reason,
            beforeTokens: e.beforeTokens,
            afterTokens: e.afterTokens,
            savedTokens: e.savedTokens,
            collapsedCount: e.collapsedCount,
          })
          if (e.applied) {
            log.info('compaction', {
              turn: e.turn,
              beforeTokens: e.beforeTokens,
              afterTokens: e.afterTokens,
              savedTokens: e.savedTokens,
              collapsedCount: e.collapsedCount,
            })
          }
        },
        messages: session.messages,
        cwd: this.cfg.cwd,
        maxTurns: this.cfg.maxTurns,
        maxParallel: this.cfg.maxParallel,
        signal: controller.signal,
        tracer: {
          onTurn: (t: TurnTrace) => {
            spent += t.costUSD
            traceStore.onTurn(t)
            sse('turn', {
              turn: t.turn,
              contextTokens: t.contextTokens,
              costUSD: t.costUSD,
              toolMs: t.toolMs,
              maxConcurrency: t.maxConcurrency,
              retries: t.retries,
              deniedTools: t.deniedTools,
              compactionSavedTokens: t.compactionSavedTokens,
              tools: t.toolUses.map((u) => u.name),
            })
            log.info('turn', { turn: t.turn, contextTokens: t.contextTokens, costUSD: t.costUSD })

            // 熔断：本次 run 累计 + 历史累计 超预算就中止
            if (session.costUSD + spent > this.cfg.sessionBudgetUSD) {
              overBudget = true
              controller.abort()
            }
          },
        },
        onToolEvent: (e) => {
          if (e.phase === 'start') sse('tool_start', { name: e.name, wave: e.wave })
          else sse('tool_end', { name: e.name, isError: e.isError, durationMs: e.durationMs })
        },
        onRetry: (info) => sse('retry', { attempt: info.attempt, delayMs: info.delayMs }),
      })

      this.sessions.charge(sessionId, spent, result.traces.length)
      log.info('run_end', {
        stopReason: result.stopReason,
        turns: result.turns,
        costUSD: spent,
        overBudget,
        error: result.error?.message,
      })
      sse('done', {
        runId,
        stopReason: result.stopReason,
        turns: result.turns,
        costUSD: spent,
        overBudget,
        compactionSavedTokens: traceStore.summary().compactionSavedTokens,
        traceFile: traceStore.path,
        finalText: result.finalText,
        error: result.error?.message,
      })
    } catch (err) {
      log.error('run_crash', { error: String(err) })
      sse('error', { message: String(err) })
    } finally {
      ended = true
      this.sseSinks.delete(sse)
      this.sessions.release(sessionId)
      this.active -= 1
      res.end()
    }
  }

  // ── 鉴权 ──────────────────────────────────────────────────

  private authorized(req: IncomingMessage): boolean {
    // 没配 token 时，config 层已保证只监听 localhost
    if (!this.cfg.authToken) return true
    const m = /^Bearer (.+)$/.exec(req.headers.authorization ?? '')
    if (!m) return false
    return safeEqual(m[1]!, this.cfg.authToken)
  }
}

// ── 工具函数 ────────────────────────────────────────────────

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(payload),
  })
  res.end(payload)
}

async function readJsonBody(req: IncomingMessage, maxBytes: number): Promise<unknown> {
  const chunks: Buffer[] = []
  let size = 0
  for await (const c of req) {
    size += (c as Buffer).length
    // 不设上限的话，一个几 GB 的请求体就能把内存吃光
    if (size > maxBytes) throw new Error(`请求体超过 ${maxBytes} 字节`)
    chunks.push(c as Buffer)
  }
  if (chunks.length === 0) return {}
  const raw = Buffer.concat(chunks).toString('utf8')
  try {
    return JSON.parse(raw)
  } catch {
    throw new Error('请求体不是合法 JSON')
  }
}

/** 定长比较，避免通过响应耗时逐字节猜出 token */
function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8')
  const bb = Buffer.from(b, 'utf8')
  if (ab.length !== bb.length) return false
  return timingSafeEqual(ab, bb)
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))
