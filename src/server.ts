/**
 * 服务入口（生产形态）
 *
 * 用法：
 *   cp .env.example .env    # 至少填 API_KEY
 *   npm run serve
 *
 * 与 `npm run dev` 的区别：dev 是你在终端里自己聊，这个是**别人来调**。
 * 所以这里多了三件 dev 不需要的事：优雅退出、定期回收、启动自检。
 *
 * Phase 2 之后还多一层：权限引擎 + 审批队列。
 * CLI 的审批门是终端问答，服务的审批门是 HTTP（POST /v1/approvals）——
 * 主循环与调度器完全不用改，这就是"策略可注入"的价值。
 */

import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { AnthropicProvider } from './api/anthropic.js'
import { OpenAICompatProvider } from './api/openai.js'
import { ToolRegistry } from './core/tool.js'
import { PermissionEngine } from './core/permissions.js'
import type { ModelProvider } from './api/types.js'
import { ReadTool } from './tools/ReadTool.js'
import { GlobTool } from './tools/GlobTool.js'
import { GrepTool } from './tools/GrepTool.js'
import { WriteTool } from './tools/WriteTool.js'
import { EditTool } from './tools/EditTool.js'
import { BashTool } from './tools/BashTool.js'
import { loadConfig } from './server/config.js'
import { JsonlLogger } from './server/log.js'
import { ApprovalQueue } from './server/approvals.js'
import { AgentServer } from './server/http.js'

function loadDotEnv(): void {
  for (const p of [join(process.cwd(), '.env')]) {
    if (!existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = /^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/.exec(line)
      if (!m || line.trimStart().startsWith('#')) continue
      if (process.env[m[1]!] === undefined) process.env[m[1]!] = m[2]!.trim()
    }
  }
}

function makeProvider(cfg: ReturnType<typeof loadConfig>): ModelProvider {
  return cfg.provider === 'anthropic'
    ? new AnthropicProvider(cfg.apiKey, cfg.baseURL)
    : new OpenAICompatProvider(cfg.apiKey, cfg.baseURL)
}

async function main(): Promise<void> {
  loadDotEnv()
  const cfg = loadConfig()
  const logger = new JsonlLogger(cfg.logDir)
  const tools = new ToolRegistry().register(
    ReadTool,
    GlobTool,
    GrepTool,
    WriteTool,
    EditTool,
    BashTool,
  )

  const approvals = new ApprovalQueue()
  const permissions = new PermissionEngine({
    mode: cfg.permissionMode,
    rules: cfg.permissionRules,
    approvalTimeoutMs: cfg.approvalTimeoutMs,
    gate: approvals.gate,
  })

  const server = new AgentServer({
    config: cfg,
    provider: makeProvider(cfg),
    tools,
    logger,
    permissions,
    approvals,
  })

  const { port, host } = await server.listen()
  console.log(`agent-runtime 服务已启动  http://${host}:${port}`)
  console.log(`  模型 ${cfg.model} · 工作目录 ${cfg.cwd} · 鉴权 ${cfg.authToken ? '已开启' : '未开启（仅本机）'}`)
  console.log(`  单会话成本上限 $${cfg.sessionBudgetUSD} · 并发上限 ${cfg.maxConcurrentRuns}`)
  console.log(
    `  权限 ${cfg.permissionMode} · 预置规则 ${cfg.permissionRules.length} 条 · ` +
      `审批超时 ${cfg.approvalTimeoutMs}ms（超时按拒绝）`,
  )

  // 定期回收空闲会话。unref() 让这个定时器不阻止进程退出
  const sweeper = setInterval(() => {
    const n = server.sessionStore.sweep(cfg.sessionIdleTTLms)
    if (n > 0) logger.info('session_sweep', { reclaimed: n })
  }, 60_000)
  sweeper.unref()

  let closing = false
  for (const sig of ['SIGINT', 'SIGTERM'] as const) {
    process.on(sig, () => {
      if (closing) return
      closing = true
      console.log(`\n收到 ${sig}，正在收尾…`)
      void server.close().then(() => process.exit(0))
    })
  }
}

main().catch((err) => {
  console.error(String(err instanceof Error ? err.message : err))
  process.exit(1)
})
