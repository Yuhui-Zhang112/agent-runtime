/**
 * 权限系统（Phase 2）
 *
 * 一句话：模型能"想"，但能不能真的"动手"，由这一层说了算。
 *
 * 两层安全，互不替代、也互不绕过：
 *
 *  【策略层 · 本文件】可配置。模式（plan / default / acceptEdits /
 *  bypassPermissions）、规则（谁允许、谁拒绝）、以及需要人工批准时的审批门。
 *  它回答的是「这一次调用，用户允许吗」。
 *
 *  【结构层 · 工具内部】不可配置。路径越界、危险命令、密钥环境变量、
 *  超时、输出上限。它回答的是「就算用户同意，这件事本身能不能做」。
 *  所以 bypassPermissions 也不能让 `rm -rf /` 通过 —— 它只跳过"询问"。
 *
 * 四条硬规矩：
 *  1. fail-closed：不认识的工具、没配审批通道、审批超时、审批抛异常，
 *     一律拒绝。默认状态永远是"不许"。
 *  2. 拒绝不是抛异常，而是产出一条 isError 的 tool_result 回给模型。
 *     抛异常会崩掉主循环，少一条结果会让 tool_use 变孤儿、API 直接 400。
 *  3. 审批串行：一轮里多个工具需要批准时按顺序问，不并发弹窗。
 *  4. 决策全程留痕（onDecision），Trace / SSE / JSONL 都靠它。
 */

import type { RiskLevel } from './tool.js'

export type PermissionMode = 'default' | 'plan' | 'acceptEdits' | 'bypassPermissions'
export type PermissionAction = 'allow' | 'deny' | 'ask'
export type ApprovalDecision = 'allow' | 'deny' | 'always'

export const PERMISSION_MODES: readonly PermissionMode[] = [
  'default',
  'plan',
  'acceptEdits',
  'bypassPermissions',
]

/** 一条权限规则。pattern 对 Bash 匹配 command，对文件工具匹配 path */
export interface PermissionRule {
  /** 工具名，或 '*' 表示所有工具 */
  tool: string
  action: PermissionAction
  /** glob：'*' 匹配任意字符。省略 = 该工具的所有调用 */
  pattern?: string
  note?: string
}

/** 需要人做决定时，交给审批门的信息 */
export interface PermissionRequest {
  id: string
  toolName: string
  input: unknown
  level: RiskLevel
  /** 人看得懂的一句话，例如 Bash(npm test) */
  target: string
  reason: string
  timeoutMs: number
}

/** 审批门：CLI 里是终端问答，服务里是 HTTP 审批队列，测试里是确定性函数 */
export type ApprovalGate = (
  req: PermissionRequest,
  signal?: AbortSignal,
) => Promise<ApprovalDecision>

/** 一次调用的最终裁决。action 是规则给出的初始动作，final 是问完人之后的结论 */
export interface PermissionDecision {
  toolName: string
  level: RiskLevel
  action: PermissionAction
  final: 'allow' | 'deny'
  reason: string
  matchedRule?: string
  asked: boolean
  timedOut: boolean
  target: string
}

export interface PermissionEngineOptions {
  mode?: PermissionMode
  rules?: PermissionRule[]
  gate?: ApprovalGate
  /** 审批最多等多久。超时按拒绝处理，绝不无限挂住一轮 */
  approvalTimeoutMs?: number
  onDecision?: (d: PermissionDecision) => void
  /** 生成请求 id，测试可注入 */
  makeId?: () => string
}

export const DEFAULT_APPROVAL_TIMEOUT_MS = 60_000

/**
 * 结构性硬约束：这些命令无论什么模式、什么规则都不放行。
 * 它们属于"工具内部也不该执行"的那类事，放在这里是为了让策略层和
 * 工具层共享同一份清单，避免两处规则漂移。
 */
export const DANGEROUS_COMMAND_PATTERNS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /\brm\s+(-[a-zA-Z]*\s+)*(\/|~|\$HOME)(\s|$|\/\*)/i, why: '删除根目录或家目录' },
  { re: /\bsudo\b/, why: '提权执行' },
  { re: /\b(mkfs(\.\w+)?|diskutil\s+eraseDisk)\b/, why: '格式化磁盘' },
  { re: /\bdd\s+if=/, why: '裸写块设备' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: '关机 / 重启' },
  { re: />\s*\/dev\/(sd|disk|nvme)/, why: '写裸设备' },
  { re: /:\s*\(\s*\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;?/, why: 'fork bomb' },
  { re: /\b(curl|wget)\b[^\n|]*\|\s*(sudo\s+)?(ba|z|k)?sh\b/, why: '下载内容直接管道给 shell' },
  { re: /\b(chmod|chown)\s+(-R\s+)?(777|a\+rwx)\s+\//, why: '递归放开根目录权限' },
  { re: /\b(rm|mv|chmod|chown|cp)\s+(-[a-zA-Z]+\s+)*\/etc\b/, why: '改动系统配置目录' },
]

/** 命令/路径里不允许出现的东西（结构性） */
export function hardDeny(toolName: string, input: unknown): string | null {
  if (toolName !== 'Bash') return null
  const command = field(input, 'command')
  if (typeof command !== 'string' || command.trim() === '') {
    return 'Bash 需要非空的 command'
  }
  if (command.length > 4000) return `命令过长（${command.length} > 4000 字符）`
  for (const p of DANGEROUS_COMMAND_PATTERNS) {
    if (p.re.test(command)) return `危险命令已硬拦截：${p.why}`
  }
  return null
}

/** 从工具参数里取出"这次要动什么"，用于规则匹配与展示 */
export function describeTarget(toolName: string, input: unknown): string {
  const value =
    field(input, 'command') ??
    field(input, 'path') ??
    field(input, 'file_path') ??
    field(input, 'pattern') ??
    (input === undefined || input === null ? '' : JSON.stringify(input))
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const clipped = text.length > 160 ? `${text.slice(0, 160)}…` : text
  return `${toolName}(${clipped})`
}

export class PermissionEngine {
  private mode: PermissionMode
  private readonly rules: PermissionRule[]
  private readonly gate?: ApprovalGate
  private readonly approvalTimeoutMs: number
  private onDecision?: (d: PermissionDecision) => void
  private readonly makeId: () => string

  constructor(opts: PermissionEngineOptions = {}) {
    this.mode = opts.mode ?? 'default'
    if (!PERMISSION_MODES.includes(this.mode)) {
      throw new Error(`未知权限模式：${String(this.mode)}`)
    }
    this.rules = [...(opts.rules ?? [])]
    this.gate = opts.gate
    this.approvalTimeoutMs = Math.max(1, opts.approvalTimeoutMs ?? DEFAULT_APPROVAL_TIMEOUT_MS)
    this.onDecision = opts.onDecision
    this.makeId = opts.makeId ?? (() => `pa_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`)
  }

  get currentMode(): PermissionMode {
    return this.mode
  }

  setMode(mode: PermissionMode): void {
    if (!PERMISSION_MODES.includes(mode)) throw new Error(`未知权限模式：${String(mode)}`)
    this.mode = mode
  }

  addRule(rule: PermissionRule): void {
    if (!PERMISSION_ACTIONS.includes(rule.action)) {
      throw new Error(`未知规则动作：${String(rule.action)}`)
    }
    this.rules.push(rule)
  }

  listRules(): readonly PermissionRule[] {
    return this.rules
  }

  describe(): { mode: PermissionMode; rules: readonly PermissionRule[]; approvalTimeoutMs: number; hasGate: boolean } {
    return {
      mode: this.mode,
      rules: this.rules,
      approvalTimeoutMs: this.approvalTimeoutMs,
      hasGate: this.gate !== undefined,
    }
  }

  /** 运行时挂/换决策监听器：服务层用它把裁决推给 SSE，测试里用它收集证据 */
  setDecisionListener(fn?: (d: PermissionDecision) => void): void {
    this.onDecision = fn
  }

  /** 纯决策：不询问人，只算规则。用于 /permissions 预览和单测 */
  explain(toolName: string, input: unknown, level: RiskLevel): PermissionDecision {
    const target = describeTarget(toolName, input)
    const base = (action: PermissionAction, reason: string, matchedRule?: string): PermissionDecision => ({
      toolName,
      level,
      action,
      final: action === 'allow' ? 'allow' : action === 'ask' ? 'deny' : 'deny',
      reason,
      ...(matchedRule ? { matchedRule } : {}),
      asked: false,
      timedOut: false,
      target,
    })

    // ① 结构性硬约束：任何模式、任何规则都盖不过它
    const hard = hardDeny(toolName, input)
    if (hard) return base('deny', hard)

    // ② 显式规则优先。deny > ask > allow；带 pattern 的更具体；精确工具名 > '*'
    const matched = this.matchRule(toolName, input)
    if (matched) {
      const label = formatRule(matched)
      return base(matched.action, `命中规则 ${label}`, label)
    }

    // ③ 模式默认
    switch (this.mode) {
      case 'plan':
        return level === 'read'
          ? base('allow', 'plan 模式：只读操作放行')
          : base('deny', 'plan 模式：只许看，不许改 / 执行')
      case 'bypassPermissions':
        return base('allow', 'bypassPermissions：跳过询问（结构性硬约束仍生效）')
      case 'acceptEdits':
        return level === 'execute'
          ? base('ask', 'acceptEdits：命令执行仍需批准')
          : base('allow', 'acceptEdits：读写操作放行')
      default:
        return level === 'read'
          ? base('allow', 'default：只读操作放行')
          : base('ask', `default：${level === 'execute' ? '命令执行' : '文件修改'}需要批准`)
    }
  }

  /** 完整裁决：ask 时调审批门，超时 / 无门 / 异常一律拒绝 */
  async authorize(
    toolName: string,
    input: unknown,
    level: RiskLevel,
    signal?: AbortSignal,
  ): Promise<PermissionDecision> {
    const d = this.explain(toolName, input, level)
    if (d.action !== 'ask') {
      this.onDecision?.(d)
      return d
    }
    if (signal?.aborted) {
      return this.finish({ ...d, final: 'deny', reason: '已中断，取消审批' })
    }
    if (!this.gate) {
      return this.finish({ ...d, final: 'deny', reason: `${d.reason}，但当前没有审批通道（fail-closed）` })
    }

    const req: PermissionRequest = {
      id: this.makeId(),
      toolName,
      input,
      level,
      target: d.target,
      reason: d.reason,
      timeoutMs: this.approvalTimeoutMs,
    }

    let decision: ApprovalDecision
    let timedOut = false
    try {
      const got = await withTimeout(this.gate(req, signal), this.approvalTimeoutMs, signal)
      if (got === 'timeout') {
        timedOut = true
        decision = 'deny'
      } else {
        decision = got
      }
    } catch {
      decision = 'deny'
    }

    if (decision === 'always') {
      // 只记住这一条确切命令 / 路径，不记整类 —— 避免一次"always"放开一大片
      const target = targetValue(toolName, input)
      if (target) {
        this.addRule({ tool: toolName, action: 'allow', pattern: target, note: '用户选择 always' })
      }
      return this.finish({ ...d, asked: true, timedOut, final: 'allow', reason: '用户批准并记住该规则' })
    }
    if (decision === 'allow') {
      return this.finish({ ...d, asked: true, timedOut, final: 'allow', reason: '用户批准' })
    }
    return this.finish({
      ...d,
      asked: true,
      timedOut,
      final: 'deny',
      reason: timedOut ? '审批超时，按拒绝处理' : '用户拒绝',
    })
  }

  /** 一批工具按顺序预检。串行是为了审批顺序确定、不并发弹窗 */
  async authorizeBatch(
    uses: ReadonlyArray<{ name: string; input: unknown; level: RiskLevel }>,
    signal?: AbortSignal,
  ): Promise<PermissionDecision[]> {
    const out: PermissionDecision[] = []
    for (const u of uses) {
      out.push(await this.authorize(u.name, u.input, u.level, signal))
    }
    return out
  }

  private finish(d: PermissionDecision): PermissionDecision {
    this.onDecision?.(d)
    return d
  }

  private matchRule(toolName: string, input: unknown): PermissionRule | undefined {
    const target = targetValue(toolName, input)
    const candidates = this.rules.filter((r) => {
      if (r.tool !== '*' && r.tool !== toolName) return false
      if (!r.pattern) return true
      return target !== null && globMatch(target, r.pattern)
    })
    if (candidates.length === 0) return undefined
    // 排序键越小越优先：deny 最优先，其次有 pattern、精确工具名
    candidates.sort((a, b) => ruleScore(a) - ruleScore(b))
    return candidates[0]
  }
}

const PERMISSION_ACTIONS: readonly PermissionAction[] = ['allow', 'deny', 'ask']

function ruleScore(r: PermissionRule): number {
  const actionRank = r.action === 'deny' ? 0 : r.action === 'ask' ? 1 : 2
  return actionRank * 100 + (r.pattern ? 0 : 10) + (r.tool === '*' ? 1 : 0)
}

export function formatRule(r: PermissionRule): string {
  return `${r.tool}${r.pattern ? `(${r.pattern})` : ''} → ${r.action}`
}

/** glob 只支持 '*' 和 '?'，其余字符一律转义 —— 不引入正则注入 */
export function globMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&')
  const body = escaped.replace(/\*/g, '.*').replace(/\?/g, '.')
  try {
    return new RegExp(`^${body}$`, 's').test(value)
  } catch {
    return false
  }
}

/** 取用于匹配的原始值：Bash=command、文件工具=path，其余 JSON */
function targetValue(toolName: string, input: unknown): string | null {
  const v =
    field(input, 'command') ??
    field(input, 'path') ??
    field(input, 'file_path') ??
    field(input, 'pattern')
  if (typeof v === 'string') return v
  return input === undefined || input === null ? null : JSON.stringify(input)
}

function field(input: unknown, key: string): unknown {
  if (typeof input !== 'object' || input === null) return undefined
  return (input as Record<string, unknown>)[key]
}

/** 超时与中断都收敛成 'timeout' 字符串，不抛异常 */
async function withTimeout<T>(
  p: Promise<T>,
  ms: number,
  signal?: AbortSignal,
): Promise<T | 'timeout'> {
  return new Promise<T | 'timeout'>((resolve) => {
    let settled = false
    const done = (v: T | 'timeout') => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      signal?.removeEventListener('abort', onAbort)
      resolve(v)
    }
    const timer = setTimeout(() => done('timeout'), ms)
    const onAbort = () => done('timeout')
    signal?.addEventListener('abort', onAbort, { once: true })
    Promise.resolve(p).then(
      (v) => done(v),
      () => done('timeout'),
    )
  })
}
