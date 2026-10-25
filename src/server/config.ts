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
}

const DEFAULT_SYSTEM =
  'You are a coding agent with tools: Glob (find files), Grep (search content), ' +
  'Read (read file), Write (create NEW file only), Edit (modify existing file).\n' +
  'Rules: explore with Glob/Grep/Read before answering about code. ' +
  'Write refuses to overwrite existing files - use Edit for those. ' +
  'Edit requires oldString to be unique in the file. Be concise and direct.'

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
  }
}

function num(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === '') return fallback
  const n = Number(raw)
  if (!Number.isFinite(n)) throw new Error(`环境变量不是数字：${raw}`)
  return n
}
