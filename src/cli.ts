/**
 * Phase 1 入口：带工具的主循环 REPL
 *
 * 与 Phase 0 的区别：这里不再是"一问一答"，而是 runAgent 主循环 ——
 * 模型可以连续调用工具（目前有 Read），拿到结果后再继续，直到它自己说结束。
 *
 * 命令：/exit 退出 · /stats 累计用量 · /clear 清空历史 · /tools 看有哪些工具
 */

import { createInterface } from 'node:readline'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AnthropicProvider } from './api/anthropic.js'
import { OpenAICompatProvider } from './api/openai.js'
import { runAgent, type TurnTrace } from './core/runAgent.js'
import { ToolRegistry } from './core/tool.js'
import { ReadTool } from './tools/ReadTool.js'
import { createUserMessage, type Message } from './types/message.js'
import type { ModelProvider } from './api/types.js'

const SYSTEM =
  'You are a coding agent running in a terminal. ' +
  'You can call tools to inspect the user\'s project. ' +
  'Prefer reading files before answering questions about code. ' +
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
  const tools = new ToolRegistry().register(ReadTool)

  const messages: Message[] = []
  const totals = { turns: 0, toolCalls: 0, input: 0, output: 0, cost: 0 }

  console.log(C.dim(`\n  agent-runtime · Phase 1（主循环 + 工具）`))
  console.log(C.dim(`  provider=${provider.name}  model=${model}`))
  console.log(C.dim(`  工具：${tools.list().map((t) => t.name).join(', ')}`))
  console.log(C.dim(`  /exit 退出 · /stats 用量 · /clear 清空 · /tools 工具列表\n`))

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r))

  while (true) {
    let input: string
    try {
      input = (await ask(C.cyan('you › '))).trim()
    } catch {
      break
    }

    if (!input) continue
    if (input === '/exit' || input === '/quit') break

    if (input === '/tools') {
      for (const t of tools.list()) {
        console.log(C.dim(`  ${t.name}  ${t.isReadOnly ? '(只读)' : '(会修改文件)'} — ${t.description}`))
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
        messages,
        signal: controller.signal,
        maxTurns: 25,
        tracer: {
          onTurn: (t: TurnTrace) => {
            totals.turns += 1
            totals.toolCalls += t.toolUses.length
            totals.input += t.inputTokens
            totals.output += t.outputTokens
            totals.cost += t.costUSD
            if (t.toolUses.length > 0) {
              console.log(C.dim(`    第 ${t.turn} 轮 · 调用 ${t.toolUses.map((u) => u.name).join(', ')}`))
            }
          },
        },
      })

      console.log(C.green('agent › ') + result.finalText)
      console.log(
        C.dim(
          `  ${result.stopReason} · ${result.turns} 轮 · ${Date.now() - startedAt}ms`,
        ),
      )
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
