/**
 * BashTool —— 能执行任意命令的工具（Phase 2 的主角）
 *
 * 一句话：它是整个项目里权限面最大的工具。加了它，agent 从"能读写文件"
 * 变成"能干活"；也正因如此，**必须先有权限系统**才能把它挂上去。
 *
 * 两层安全在这里都能看到：
 *  - 策略层：tool.risk = 'execute'，由 core/permissions.ts 决定要不要问人。
 *  - 结构层（本文件，不可被任何规则绕过）：危险命令黑名单、敏感文件读取拦截、
 *    环境变量白名单（API key 根本不会传进子进程）、cwd 固定、超时杀进程组、
 *    输出硬截断、中断即 kill。
 *
 * 诚实说明：命令里的静态匹配是**纵深防御，不是沙箱**。变量拼接、编码、
 * 别名都能绕开字符串检查。真正的隔离边界是操作系统用户权限 / 容器
 * （Dockerfile 里已用非 root 用户）。这一层负责的是"别让明显的手滑变成事故"。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { resolve } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolContext, type ToolResult } from '../core/tool.js'
import { hardDeny } from '../core/permissions.js'

const DEFAULT_TIMEOUT_MS = 30_000
const MAX_TIMEOUT_MS = 120_000
const MAX_COMMAND_CHARS = 4000
const MAX_EACH_OUTPUT_CHARS = 15_000

/** 只把这些环境变量传进子进程 —— API_KEY / AUTH_TOKEN / 各类密钥一律不传 */
const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'LANG',
  'LC_ALL',
  'TERM',
  'TMPDIR',
  'SHELL',
  'USER',
  'TZ',
  'NODE_ENV',
] as const

const SENSITIVE_PATH_PATTERNS: ReadonlyArray<{ re: RegExp; why: string }> = [
  { re: /\.ssh\/|\bid_rsa\b|\bid_ed25519\b/i, why: 'SSH 私钥' },
  { re: /\.aws\/(credentials|config)/i, why: '云凭证' },
  { re: /\.git-credentials|\.netrc|\.npmrc/i, why: '令牌文件' },
  { re: /(^|[\s'"=])\.env([\s'"=]|$)/i, why: '环境变量文件' },
]

export const BashInputSchema = z.object({
  command: z.string().min(1, 'command 不能为空').max(MAX_COMMAND_CHARS),
  timeoutMs: z.number().int().min(1).max(MAX_TIMEOUT_MS).optional(),
  description: z.string().max(200).optional(),
})

export const BashTool = defineTool({
  name: 'Bash',
  risk: 'execute',
  description:
    '在锁定的工作目录里执行一条 shell 命令。会写文件、会消耗资源，' +
    '因此每次调用都可能需要用户批准。危险命令（rm -rf /、sudo、管道下载执行等）' +
    '与敏感文件读取会被硬拦截；子进程拿不到任何 API key；超时会被强制终止。' +
    '命令超时默认 30 秒，最长 120 秒。用 description 说明你为什么要用它。',
  inputSchema: BashInputSchema,
  // 故意不声明 isReadOnly / isConcurrencySafe —— 默认 false，独占执行
  async call(input, ctx): Promise<ToolResult> {
    // ① 结构性硬约束：即使有人绕过调度器直接调 runTool，这里也拦得住
    const denied = hardDeny('Bash', { command: input.command, timeoutMs: input.timeoutMs })
    if (denied) return { output: `权限拒绝：${denied}`, isError: true }
    if (input.command.length > MAX_COMMAND_CHARS) {
      return { output: `权限拒绝：命令过长（上限 ${MAX_COMMAND_CHARS} 字符）`, isError: true }
    }
    for (const p of SENSITIVE_PATH_PATTERNS) {
      if (p.re.test(input.command)) {
        return { output: `权限拒绝：命令涉及${p.why}，已硬拦截`, isError: true }
      }
    }

    const cwd = resolve(ctx.cwd)
    const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS
    const env = safeEnv(cwd)

    if (ctx.signal?.aborted) {
      return { output: '已取消（用户中断，命令未执行）', isError: true }
    }

    return new Promise<ToolResult>((resolvePromise) => {
      let stdout = ''
      let stderr = ''
      let stdoutTotal = 0
      let stderrTotal = 0
      let timedOut = false
      let aborted = false
      let settled = false

      // detached 让子进程自成一组：超时能连它派生的子进程一起杀掉，
      // 否则 `sh -c "npm run ..."` 超时后 npm 还在后台跑。
      const child: ChildProcess = spawn('/bin/sh', ['-c', input.command], {
        cwd,
        env,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      })

      const build = (code: number | null, signal: NodeJS.Signals | null): ToolResult => {
        const head =
          `$ ${input.command}\n` +
          `cwd: ${cwd}  ·  exit: ${code ?? (signal ? `signal ${signal}` : 'unknown')}` +
          `${timedOut ? '  ·  [超时已终止]' : ''}${aborted ? '  ·  [用户中断]' : ''}\n`
        const outPart = stdout ? `\n--- stdout ---\n${stdout}${clipNote(stdoutTotal, stdout.length)}` : ''
        const errPart = stderr ? `\n--- stderr ---\n${stderr}${clipNote(stderrTotal, stderr.length)}` : ''
        const body = head + outPart + errPart
        const failed = timedOut || aborted || code === null || code !== 0
        return {
          output: failed ? `${body}\n[命令未成功结束]` : body,
          isError: failed,
        }
      }

      const settle = (result: ToolResult): void => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        clearTimeout(fallback)
        ctx.signal?.removeEventListener('abort', onAbort)
        resolvePromise(result)
      }

      const killGroup = (): void => {
        const pid = child.pid
        if (pid === undefined) {
          child.kill('SIGKILL')
          return
        }
        try {
          process.kill(-pid, 'SIGKILL')
        } catch {
          try {
            child.kill('SIGKILL')
          } catch {
            // 进程可能刚好自己退出了
          }
        }
      }

      const onAbort = (): void => {
        aborted = true
        killGroup()
        // kill 之后 close 通常会到；万一没到，兜底 resolve，绝不把主循环挂死
        fallback = setTimeout(() => settle(build(null, 'SIGKILL')), 1000)
      }

      child.stdout?.on('data', (c: Buffer) => {
        const s = c.toString('utf8')
        stdoutTotal += s.length
        if (stdout.length < MAX_EACH_OUTPUT_CHARS) {
          stdout += s.slice(0, MAX_EACH_OUTPUT_CHARS - stdout.length)
        }
      })
      child.stderr?.on('data', (c: Buffer) => {
        const s = c.toString('utf8')
        stderrTotal += s.length
        if (stderr.length < MAX_EACH_OUTPUT_CHARS) {
          stderr += s.slice(0, MAX_EACH_OUTPUT_CHARS - stderr.length)
        }
      })

      child.on('error', (err) => {
        settle({
          output: `$ ${input.command}\n无法启动子进程：${err.message}`,
          isError: true,
        })
      })
      child.on('close', (code, signal) => settle(build(code, signal)))

      let fallback: ReturnType<typeof setTimeout> | undefined
      const timer = setTimeout(() => {
        timedOut = true
        killGroup()
        fallback = setTimeout(() => settle(build(null, 'SIGKILL')), 1000)
      }, timeoutMs)

      ctx.signal?.addEventListener('abort', onAbort, { once: true })
      if (ctx.signal?.aborted) onAbort()
    })
  },
})

function safeEnv(cwd: string): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { PWD: cwd }
  for (const k of ENV_ALLOWLIST) {
    const v = process.env[k]
    if (v !== undefined) out[k] = v
  }
  return out
}

function clipNote(total: number, kept: number): string {
  return total > kept ? `\n[输出已截断：原始 ${total} 字符，保留 ${kept} 字符]` : ''
}
