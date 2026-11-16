/**
 * Phase 2 入口：带权限系统的主循环 REPL
 *
 * 与 Phase 1 的区别：多了一个 BashTool（能执行任意命令），
 * 以及拦在它前面的权限系统。命令 / 文件修改默认要问人，
 * 只读工具直接放行；被拒绝也是一条正常的 tool_result，模型不会崩。
 *
 * 命令：/exit 退出 · /stats 用量 · /clear 清空 · /tools 工具列表
 *      /permissions 看模式与规则 · /mode <模式> 切换 · /allow <工具> [模式] 加允许规则
 */

import { createInterface } from 'node:readline'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AnthropicProvider } from './api/anthropic.js'
import { OpenAICompatProvider } from './api/openai.js'
import { runAgent, type TurnTrace } from './core/runAgent.js'
import { ToolRegistry } from './core/tool.js'
import {
  PermissionEngine,
  PERMISSION_MODES,
  formatRule,
  type PermissionMode,
} from './core/permissions.js'
import { ReadTool } from './tools/ReadTool.js'
import { GlobTool } from './tools/GlobTool.js'
import { GrepTool } from './tools/GrepTool.js'
import { WriteTool } from './tools/WriteTool.js'
import { EditTool } from './tools/EditTool.js'
import { BashTool } from './tools/BashTool.js'
import { createUserMessage, type Message } from './types/message.js'
import type { ModelProvider } from './api/types.js'

const SYSTEM =
  'You are a coding agent running in a terminal. ' +
  'You have tools: Glob (find files), Grep (search content), Read (read file), ' +
  'Write (create NEW file only), Edit (modify existing file), ' +
  'Bash (run a shell command; subject to user approval).\n' +
  'Rules: explore with Glob/Grep/Read before answering about code. ' +
  'Write refuses to overwrite existing files - use Edit for those. ' +
  'Edit requires oldString to be unique in the file. ' +
  'A permission denial is a real result: do NOT retry the same command, ' +
  'switch to read-only tools or explain to the user. ' +
  'Be concise and direct.'

// ── 环境变量 ────────────────────────────────────────────────

function loadDotEnv(): void {
  for (const p of [join(process.cwd(), '.env'), join(homedir(), '.agent-runtime.env')]) {
    if (!existsSync(p)) continue
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
      if (!m) continue
      const key = m[1]!
      if (process.env[key] !== undefined) continue
      process.env[key] = m[2]!.replace(/^["']|["']$/g, '')
    }
  }
}

function resolveProvider(): { provider: ModelProvider; model: string } {
  const anthropicKey = process.env.ANTHROPIC_API_KEY
  const openaiKey = process.env.OPENAI_API_KEY ?? process.env.LLM_API_KEY

  if (anthropicKey) {
    return {
      provider: new AnthropicProvider(anthropicKey, process.env.ANTHROPIC_BASE_URL),
      model: process.env.ANTHROPIC_MODEL ?? 'claude-sonnet-4-5',
    }
  }
  if (openaiKey) {
    return {
      provider: new OpenAICompatProvider(
        openaiKey,
        process.env.OPENAI_BASE_URL ?? 'https://api.deepseek.com/v1',
      ),
      model: process.env.LLM_MODEL ?? 'deepseek-chat',
    }
  }
  console.error('\n未检测到 API key。请在项目根目录创建 .env：\n')
  console.error('  # 方案 A：Anthropic')
  console.error('  ANTHROPIC_API_KEY=sk-ant-...')
  console.error('  ANTHROPIC_MODEL=claude-sonnet-4-5\n')
  console.error('  # 方案 B：任意 OpenAI 兼容接口（DeepSeek / 通义 / 智谱 / 本地 vLLM）')
  console.error('  OPENAI_API_KEY=sk-...')
  console.error('  OPENAI_BASE_URL=https://api.deepseek.com/v1')
  console.error('  LLM_MODEL=deepseek-chat\n')
  process.exit(1)
}

function parseMode(raw: string | undefined): PermissionMode {
  if (raw && PERMISSION_MODES.includes(raw as PermissionMode)) return raw as PermissionMode
  return 'default'
}

// ── 渲染 ────────────────────────────────────────────────────

const C = {
  dim: (s: string) => `\x1b[2m${s}\x1b[0m`,
  cyan: (s: string) => `\x1b[36m${s}\x1b[0m`,
  green: (s: string) => `\x1b[32m${s}\x1b[0m`,
  yellow: (s: string) => `\x1b[33m${s}\x1b[0m`,
}

// ── 主流程 ──────────────────────────────────────────────────

async function main(): Promise<void> {
  loadDotEnv()
  const { provider, model } = resolveProvider()
  const tools = new ToolRegistry().register(
    ReadTool,
    GlobTool,
    GrepTool,
    WriteTool,
    EditTool,
    BashTool,
  )

  const messages: Message[] = []
  const totals = { turns: 0, toolCalls: 0, input: 0, output: 0, cost: 0 }

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r))

  // 审批门 = 终端问答。服务形态会换成 HTTP 审批队列，主循环完全不用改。
  const permissions = new PermissionEngine({
    mode: parseMode(process.env.PERMISSION_MODE),
    approvalTimeoutMs: 300_000,
    gate: async (req) => {
      console.log(C.yellow(`\n  ⚠ 需要批准：${req.target}`))
      console.log(C.dim(`    原因：${req.reason}`))
      const ans = (await ask('    允许吗？[y=这一次 / a=总是记住 / N=拒绝] ')).trim().toLowerCase()
      if (ans === 'a') return 'always'
      if (ans === 'y' || ans === 'yes') return 'allow'
      return 'deny'
    },
    onDecision: (d) => {
      if (d.final === 'deny') console.log(C.yellow(`      ⛔ ${d.toolName} 被拦：${d.reason}`))
      else if (d.asked) console.log(C.green(`      ✓ 已批准 ${d.target}`))
    },
  })

  console.log(C.dim(`\n  agent-runtime · Phase 2（权限系统 + Bash）`))
  console.log(C.dim(`  provider=${provider.name}  model=${model}`))
  console.log(C.dim(`  工具：${tools.list().map((t) => t.name).join(', ')}`))
  console.log(C.dim(`  权限模式：${permissions.currentMode}（/permissions 查看规则，/mode 切换）`))
  console.log(C.dim(`  /exit 退出 · /stats 用量 · /clear 清空 · /tools 工具列表\n`))

  while (true) {
    let input: string
    try {
      input = (await ask(C.cyan('you › '))).trim()
    } catch {
      break
    }

    if (!input) continue
    if (input === '/exit' || input === '/quit') break

    if (input === '/permissions') {
      console.log(C.dim(`  当前模式：${permissions.currentMode}`))
      console.log(C.dim(`  可选模式：${PERMISSION_MODES.join(' / ')}`))
      const rules = permissions.listRules()
      console.log(C.dim(rules.length === 0 ? '  自定义规则：无' : '  自定义规则：'))
      for (const r of rules) console.log(C.dim(`    ${formatRule(r)}`))
      continue
    }

    if (input.startsWith('/mode ')) {
      const next = input.slice(6).trim() as PermissionMode
      if (!PERMISSION_MODES.includes(next)) {
        console.log(C.yellow(`  未知模式。可选：${PERMISSION_MODES.join(' / ')}`))
      } else {
        permissions.setMode(next)
        console.log(C.green(`  已切换到 ${next}`))
      }
      continue
    }

    if (input.startsWith('/allow ')) {
      const [tool, ...rest] = input.slice(7).trim().split(/\s+/)
      if (!tool) {
        console.log(C.yellow('  用法：/allow <工具名> [glob 模式]'))
      } else {
        const pattern = rest.join(' ') || undefined
        permissions.addRule({ tool, action: 'allow', ...(pattern ? { pattern } : {}) })
        console.log(C.green(`  已添加：${formatRule({ tool, action: 'allow', ...(pattern ? { pattern } : {}) })}`))
      }
      continue
    }

    if (input === '/tools') {
      for (const t of tools.list()) {
        console.log(
          C.dim(`  ${t.name}  [${t.risk}] ${t.isReadOnly ? '(只读)' : '(会修改)'} — ${t.description}`),
        )
      }
      continue
    }
    if (input === '/stats') {
      console.log(
        C.dim(
          `  累计：${totals.turns} 轮 · ${totals.toolCalls} 次工具调用 · ` +
            `in ${totals.input} / out ${totals.output} · $${totals.cost.toFixed(4)}`,
        ),
      )
      continue
    }
    if (input === '/clear') {
      messages.length = 0
      console.log(C.dim('  已清空历史'))
      continue
    }

    messages.push(createUserMessage(input, messages.at(-1)?.uuid ?? null))

    const controller = new AbortController()
    const onSigint = () => controller.abort()
    process.once('SIGINT', onSigint)

    const startedAt = Date.now()
    try {
      const result = await runAgent({
        provider,
        model,
        system: SYSTEM,
        tools,
        permissions,
        messages,
        signal: controller.signal,
        maxTurns: 25,
        maxParallel: 8,
        tracer: {
          onTurn: (t: TurnTrace) => {
            totals.turns += 1
            totals.toolCalls += t.toolUses.length
            totals.input += t.inputTokens
            totals.output += t.outputTokens
            totals.cost += t.costUSD
            if (t.toolUses.length > 0) {
              const parallel = t.maxConcurrency > 1 ? ` ×${t.maxConcurrency} 并发` : ''
              const denied = t.deniedTools > 0 ? ` · ${t.deniedTools} 次被权限拦下` : ''
              console.log(
                C.dim(
                  `    第 ${t.turn} 轮 · 调用 ${t.toolUses.map((u) => u.name).join(', ')}${parallel}` +
                    ` · 工具耗时 ${t.toolMs}ms · 上下文 ${t.contextTokens}${denied}`,
                ),
              )
            }
          },
        },
        // 单个工具的实时进度。只读工具是并发跑的，所以这里会看到"同时开始"
        onToolEvent: (e) => {
          if (e.phase === 'start') {
            console.log(C.dim(`      ⋯ ${e.name}`))
          } else {
            const flag = e.isError ? C.yellow(' ✗') : ''
            console.log(C.dim(`      ✓ ${e.name} ${e.durationMs}ms${flag}`))
          }
        },
        // 网络抖动时告诉用户"还在救"，而不是让他对着卡住的界面发呆
        onRetry: (info) => {
          if (!info.willRetry) return
          const why = info.error.status ? `HTTP ${info.error.status}` : '网络异常'
          console.log(
            C.yellow(`    ⟳ ${why}，${(info.delayMs / 1000).toFixed(1)}s 后第 ${info.attempt} 次重试`),
          )
        },
      })

      console.log(C.green('agent › ') + result.finalText)
      console.log(C.dim(`  ${result.stopReason} · ${result.turns} 轮 · ${Date.now() - startedAt}ms`))
      if (result.error) console.log(C.yellow(`  出错了：${result.error.message}`))
    } catch (err) {
      console.error(C.yellow(`  出错了：${err instanceof Error ? err.message : String(err)}`))
    } finally {
      process.off('SIGINT', onSigint)
    }
  }

  rl.close()
  console.log(C.dim('\n  再见。\n'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
