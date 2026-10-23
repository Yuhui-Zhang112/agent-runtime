/**
 * Phase 0 入口：最小可用对话 REPL
 *
 * 目标只有一个 —— 让"终端里能跟模型流式对话"这件事立刻成立。
 * 主循环 / 工具系统都是 Phase 1 的事，这里刻意不提前引入。
 *
 * 命令：/exit 退出 · /stats 累计用量 · /clear 清空历史
 */

import { createInterface } from 'node:readline'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { AnthropicProvider } from './api/anthropic.js'
import { OpenAICompatProvider } from './api/openai.js'
import { callModel, estimateCostUSD } from './core/callModel.js'
import { createUserMessage, type AssistantMessage, type Message } from './types/message.js'
import type { ModelProvider } from './api/types.js'

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

/** 增量打印：每个块只输出新增的后缀，避免快照重复输出 */
function renderStream(msg: AssistantMessage, printed: Map<number, number>): void {
  msg.message.content.forEach((block, i) => {
    if (block.type !== 'text') return
    const done = printed.get(i) ?? 0
    if (block.text.length > done) {
      process.stdout.write(block.text.slice(done))
      printed.set(i, block.text.length)
    }
  })
}

// ── 主流程 ──────────────────────────────────────────────────

async function main(): Promise<void> {
  loadDotEnv()
  const { provider, model } = resolveProvider()

  const messages: Message[] = []
  const totals = { input: 0, output: 0, cacheRead: 0, cost: 0, turns: 0 }

  console.log(C.dim(`\n  agent-runtime · Phase 0`))
  console.log(C.dim(`  provider=${provider.name}  model=${model}`))
  console.log(C.dim(`  /exit 退出 · /stats 用量 · /clear 清空\n`))

  const rl = createInterface({ input: process.stdin, output: process.stdout })
  const ask = (q: string) => new Promise<string>((r) => rl.question(q, r))

  while (true) {
    let input: string
    try {
      input = (await ask(C.cyan('you › ') ?? 'you › ')).trim()
    } catch {
      break
    }

    if (!input) continue
    if (input === '/exit' || input === '/quit') break

    if (input === '/stats') {
      console.log(
        C.dim(
          `  累计：${totals.turns} 轮 · in ${totals.input} / out ${totals.output} · ` +
            `cache 命中 ${totals.cacheRead} · $${totals.cost.toFixed(4)}`,
        ),
      )
      continue
    }
    if (input === '/clear') {
      messages.length = 0
      console.log(C.dim('  已清空历史'))
      continue
    }

    const userMsg = createUserMessage(input, messages.at(-1)?.uuid ?? null)
    messages.push(userMsg)

    const controller = new AbortController()
    const onSigint = () => controller.abort()
    process.once('SIGINT', onSigint)

    const printed = new Map<number, number>()
    let final: AssistantMessage | undefined
    const startedAt = Date.now()

    try {
      process.stdout.write(C.green('agent › '))
      for await (const snap of callModel(
        provider,
        {
          model,
          system:
            'You are a helpful coding agent running in a terminal. Be concise and direct.',
          messages,
          tools: [],
          maxTokens: 4096,
          signal: controller.signal,
        },
        { parentUuid: userMsg.uuid },
      )) {
        renderStream(snap, printed)
        final = snap
      }
      process.stdout.write('\n')
    } catch (err) {
      process.stdout.write('\n')
      console.error(C.yellow(`  出错了：${err instanceof Error ? err.message : String(err)}`))
      continue
    } finally {
      process.off('SIGINT', onSigint)
    }

    if (!final) continue
    messages.push(final)

    const u = final.message.usage
    if (u) {
      totals.input += u.input_tokens
      totals.output += u.output_tokens
      totals.cacheRead += u.cache_read_input_tokens ?? 0
      totals.cost += estimateCostUSD(model, u)
    }
    totals.turns += 1

    console.log(
      C.dim(
        `  ${Date.now() - startedAt}ms · in ${u?.input_tokens ?? 0} / out ${u?.output_tokens ?? 0}` +
          `${u?.cache_read_input_tokens ? ` · cache ${u.cache_read_input_tokens}` : ''}` +
          ` · $${estimateCostUSD(model, u).toFixed(5)}`,
      ),
    )
  }

  rl.close()
  console.log(C.dim('\n  再见。\n'))
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
