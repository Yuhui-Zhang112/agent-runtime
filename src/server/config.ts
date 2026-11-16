/**
 * 服务器配置
 *
 * 为什么单独抽一层：
 *   CLI 是"你自己在本机跑"，配置硬编码无所谓；
 *   服务是要部署到别人机器上的，**同一份代码在不同环境行为必须不同**，
 *   所以任何可能随环境变的东西都得从外部注入（环境变量）。
 *
 * 一条硬规矩（fail-closed）：
 *   没配 AUTH_TOKEN 时只允许绑 127.0.0.1。
 *   想让别人访问，就必须显式配密钥 —— 默认状态永远是"只有本机能用"。
 */

import {
  PERMISSION_MODES,
  type PermissionMode,
  type PermissionRule,
} from '../core/permissions.js'
import {
  DEFAULT_COMPACTION_POLICY,
  resolveCompactionPolicy,
  type CompactionPolicy,
} from '../core/compaction.js'

export type ProviderKind = 'anthropic' | 'openai'

export interface ServerConfig {
  port: number
  host: string
  /** null = 不鉴权（仅允许 localhost 时可用） */
  authToken: string | null
  provider: ProviderKind
  apiKey: string
  baseURL: string | undefined
  model: string
  /** 工具的工作根目录 —— 所有文件操作都被锁在这里面 */
  cwd: string
  system: string
  maxTurns: number
  maxParallel: number
  /** 单个会话的成本上限（USD）。超过就拒绝新请求并中止在跑的任务 */
  sessionBudgetUSD: number
  /** 全局同时在跑的任务数上限 */
  maxConcurrentRuns: number
  /** 单请求体大小上限（字节） */
  maxBodyBytes: number
  /** 会话空闲多久后被回收（ms） */
  sessionIdleTTLms: number
  /** 结构化日志目录。null = 只记内存（测试用），不落盘 */
  logDir: string | null
  /** Phase 2：权限模式 */
  permissionMode: PermissionMode
  /** Phase 2：启动时预置的规则（PERMISSION_RULES 环境变量，JSON 数组） */
  permissionRules: PermissionRule[]
  /** Phase 2：审批等待上限（ms），超时按拒绝 */
  approvalTimeoutMs: number
  /** Phase 3：上下文压缩策略。null = 关闭（对照实验的基线配置） */
  compaction: CompactionPolicy | null
  /** Phase 3：每轮 Trace 的落盘目录。null = 只记内存 */
  traceDir: string | null
}

const DEFAULT_SYSTEM =
  'You are a coding agent with tools: Glob (find files), Grep (search content), ' +
  'Read (read file), Write (create NEW file only), Edit (modify existing file), ' +
  'Bash (run a shell command; subject to permission approval).\n' +
  'Rules: explore with Glob/Grep/Read before answering about code. ' +
  'Write refuses to overwrite existing files - use Edit for those. ' +
  'Edit requires oldString to be unique in the file. ' +
  'A permission denial is a real result: do NOT retry the same command. ' +
  'Be concise and direct.'

const LOCALHOSTS = new Set(['127.0.0.1', 'localhost', '::1'])

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const provider = (env.PROVIDER ?? 'openai') as ProviderKind
  if (provider !== 'anthropic' && provider !== 'openai') {
    throw new Error(`PROVIDER 只能是 anthropic 或 openai，收到：${provider}`)
  }

  const apiKey = env.API_KEY ?? ''
  if (!apiKey) throw new Error('缺少 API_KEY')

  const authToken = env.AUTH_TOKEN?.trim() ? env.AUTH_TOKEN.trim() : null
  const host = env.HOST ?? '127.0.0.1'

  // fail-closed：对外暴露却不设密钥 = 任何人都能花你的钱、读你的文件
  if (!authToken && !LOCALHOSTS.has(host)) {
    throw new Error(`未设置 AUTH_TOKEN 时只能监听 localhost，当前 HOST=${host}`)
  }

  return {
    port: num(env.PORT, 8787),
    host,
    authToken,
    provider,
    apiKey,
    baseURL: env.BASE_URL?.trim() || undefined,
    model: env.MODEL ?? (provider === 'anthropic' ? 'claude-sonnet-4-6' : 'deepseek-chat'),
    cwd: env.CWD ?? process.cwd(),
    system: env.SYSTEM_PROMPT ?? DEFAULT_SYSTEM,
    maxTurns: num(env.MAX_TURNS, 20),
    maxParallel: num(env.MAX_PARALLEL, 8),
    sessionBudgetUSD: num(env.SESSION_BUDGET_USD, 1),
    maxConcurrentRuns: num(env.MAX_CONCURRENT_RUNS, 4),
    maxBodyBytes: num(env.MAX_BODY_BYTES, 1_000_000),
    sessionIdleTTLms: num(env.SESSION_IDLE_TTL_MS, 30 * 60 * 1000),
    logDir: env.LOG_DIR?.trim() ? env.LOG_DIR.trim() : null,
    permissionMode: parsePermissionMode(env.PERMISSION_MODE),
    permissionRules: parsePermissionRules(env.PERMISSION_RULES),
    approvalTimeoutMs: num(env.APPROVAL_TIMEOUT_MS, 60_000),
    compaction: parseCompaction(env),
    traceDir: env.TRACE_DIR?.trim() ? env.TRACE_DIR.trim() : null,
  }
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`环境变量不是数字：${raw}`)
  return n
}

/**
 * Phase 3 压缩配置解析。
 * 与权限配置同一条规矩：写错就拒绝启动（fail-closed），不带着半懂的配置跑起来。
 * 只给触发阈值、没给预算时自动取阈值一半 —— 避免「改一个参数就因 target >= trigger 报错」。
 */
function parseCompaction(env: NodeJS.ProcessEnv): CompactionPolicy | null {
  const raw = (env.COMPACTION ?? 'on').trim().toLowerCase()
  if (['off', 'false', '0', 'no'].includes(raw)) return null
  if (!['on', 'true', '1', 'yes'].includes(raw)) {
    throw new Error(`COMPACTION 只能是 on / off，收到：${raw}`)
  }

  const p: Partial<CompactionPolicy> = { enabled: true }
  const trigger = env.COMPACTION_TRIGGER_TOKENS?.trim()
  const target = env.COMPACTION_TARGET_TOKENS?.trim()
  if (trigger) p.triggerTokens = num(trigger, DEFAULT_COMPACTION_POLICY.triggerTokens)
  if (target) p.targetTokens = num(target, DEFAULT_COMPACTION_POLICY.targetTokens)
  else if (trigger && p.triggerTokens) p.targetTokens = Math.floor(p.triggerTokens / 2)
  if (env.COMPACTION_PROTECT_RECENT?.trim()) {
    p.protectRecentMessages = num(env.COMPACTION_PROTECT_RECENT, DEFAULT_COMPACTION_POLICY.protectRecentMessages)
  }
  if (env.COMPACTION_MIN_RESULT_CHARS?.trim()) {
    p.minResultChars = num(env.COMPACTION_MIN_RESULT_CHARS, DEFAULT_COMPACTION_POLICY.minResultChars)
  }
  const recoverable = env.COMPACTION_RECOVERABLE?.trim().toLowerCase()
  if (recoverable) p.recoverable = !['false', '0', 'no', 'off'].includes(recoverable)

  // 统一在这里做合法性校验，服务启动时就炸，别等跑到第 5 轮才出错
  return resolveCompactionPolicy(p)
}

/** 权限配置解析一律 fail-closed：写错就拒绝启动，不带着半懂的配置跑起来 */
function parsePermissionMode(raw: string | undefined): PermissionMode {
  const v = raw?.trim() || 'default'
  if (!PERMISSION_MODES.includes(v as PermissionMode)) {
    throw new Error(`PERMISSION_MODE 只能是 ${PERMISSION_MODES.join(' / ')}，收到：${v}`)
  }
  return v as PermissionMode
}

function parsePermissionRules(raw: string | undefined): PermissionRule[] {
  if (!raw?.trim()) return []
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new Error('PERMISSION_RULES 不是合法 JSON')
  }
  if (!Array.isArray(parsed)) throw new Error('PERMISSION_RULES 必须是数组')

  return parsed.map((r, i): PermissionRule => {
    if (typeof r !== 'object' || r === null) {
      throw new Error(`PERMISSION_RULES[${i}] 必须是对象`)
    }
    const o = r as Record<string, unknown>
    if (typeof o.tool !== 'string' || o.tool.trim() === '') {
      throw new Error(`PERMISSION_RULES[${i}].tool 必须是非空字符串`)
    }
    if (o.action !== 'allow' && o.action !== 'deny' && o.action !== 'ask') {
      throw new Error(`PERMISSION_RULES[${i}].action 只能是 allow / deny / ask`)
    }
    if (o.pattern !== undefined && typeof o.pattern !== 'string') {
      throw new Error(`PERMISSION_RULES[${i}].pattern 必须是字符串`)
    }
    return {
      tool: o.tool,
      action: o.action,
      ...(typeof o.pattern === 'string' ? { pattern: o.pattern } : {}),
    }
  })
}
