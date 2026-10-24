/**
 * 冒烟测试 · 主循环（Phase 1 的核心验收）
 *
 * 用剧本模型跑完整闭环，不联网、不花钱、完全确定性。
 * 覆盖四个场景，其中 B/C/D 在真实 API 上**根本没法稳定复现**：
 *
 *   A 正常两轮：读文件 → 回答结束
 *   B 执行到一半被中断：剩下的工具必须补合成结果，配对不许断
 *   C 模型死循环一直要工具：maxTurns 必须拦住
 *   D 模型调了不存在的工具：不能崩，要告诉模型"没有这个工具"
 *
 *   npm run smoke:agent
 */

import { z } from 'zod'
import { ScriptedProvider, type ScriptedTurn } from './scriptedModel.js'
import { ToolRegistry, defineTool } from '../core/tool.js'
import { ReadTool } from '../tools/ReadTool.js'
import { runAgent, findOrphanToolUses, type TurnTrace } from '../core/runAgent.js'
import { createUserMessage, type ContentBlock, type Message } from '../types/message.js'

function collect(traces: TurnTrace[]) {
  const t: Tracer = { onTurn: (tr) => traces.push(tr) }
  return t
}
type Tracer = { onTurn: (t: TurnTrace) => void }

/** 取出历史里第一条装着 tool_result 的用户消息 */
function toolResultBlocks(messages: Message[]): ContentBlock[] {
  for (const m of messages) {
    if (m.type === 'user' && Array.isArray(m.message.content)) return m.message.content
  }
  return []
}

async function main(): Promise<void> {
  const checks: Array<[string, boolean, string]> = []

  // ── A. 正常两轮 ─────────────────────────────────────────
  {
    const traces: TurnTrace[] = []
    const provider = new ScriptedProvider([
      {
        blocks: [
          { type: 'text', text: '我先看一下这个项目是什么。' },
          { type: 'tool_use', id: 'tu_1', name: 'Read', input: { path: 'package.json' } },
        ],
      },
      { blocks: [{ type: 'text', text: '这是一个 agent runtime 项目，用来复现智能体内核。' }] },
    ])
    const messages: Message[] = [createUserMessage('这个项目是干什么的？')]
    const r = await runAgent({
      provider,
      model: 'scripted-1',
      system: '你是一个编程助手',
      tools: new ToolRegistry().register(ReadTool),
      messages,
      tracer: collect(traces),
    })

    checks.push(['A 两轮后自然结束', r.stopReason === 'end_turn' && r.turns === 2, `${r.stopReason} / ${r.turns} 轮`])
    checks.push(['A 工具真的被执行（读到内容）', JSON.stringify(toolResultBlocks(messages)).includes('agent-runtime'), '读到了 package.json'])
    checks.push(['A 工具清单发给了模型', provider.requests[0]!.tools.some((t) => t.name === 'Read'), `${provider.requests[0]!.tools.length} 个工具`])
    checks.push(['A 最终文本正确', r.finalText.includes('agent runtime'), r.finalText.slice(0, 20)])
    checks.push(['A 无孤儿 tool_use', findOrphanToolUses(messages).length === 0, `${findOrphanToolUses(messages).length} 个孤儿`])
    checks.push(['A Trace 每轮一条', traces.length === 2 && traces[0]!.toolUses.length === 1, `第1轮 ${traces[0]!.toolUses.length} 次工具调用`])
    checks.push(['A Trace 记下了上下文 token', traces[1]!.contextTokens > traces[0]!.contextTokens, `${traces[0]!.contextTokens} → ${traces[1]!.contextTokens}`])

    console.log('\n  ── A 场景的 Trace（这就是 Phase 5 可视化的原始数据）──')
    for (const t of traces) {
      console.log(
        `  \x1b[2m第 ${t.turn} 轮 · 工具 ${t.toolUses.map((u) => u.name).join(',') || '无'} · ` +
          `in ${t.inputTokens} / out ${t.outputTokens} · 上下文 ${t.contextTokens} · ${t.durationMs}ms\x1b[0m`,
      )
    }
  }

  // ── B. 执行到一半被中断 ──────────────────────────────────
  {
    const controller = new AbortController()
    const AbortTool = defineTool({
      name: 'Abort',
      description: '测试用：一调用就触发中断',
      inputSchema: z.object({}),
      async call() {
        controller.abort()
        return { output: '已触发中断' }
      },
    })

    const provider = new ScriptedProvider([
      {
        blocks: [
          { type: 'tool_use', id: 'tu_a', name: 'Abort', input: {} },
          { type: 'tool_use', id: 'tu_b', name: 'Read', input: { path: 'package.json' } },
        ],
      },
    ])
    const messages: Message[] = [createUserMessage('干活')]
    const r = await runAgent({
      provider,
      model: 'scripted-1',
      system: '',
      tools: new ToolRegistry().register(AbortTool, ReadTool),
      messages,
      signal: controller.signal,
    })

    const blocks = toolResultBlocks(messages)

    checks.push(['B 中断后干净退出', r.stopReason === 'aborted', r.stopReason])
    checks.push(['B 未执行的工具补了合成结果', blocks.length === 2 && blocks.some((b) => b.type === 'tool_result' && b.is_error === true), `${blocks.length} 条结果`])
    checks.push(['B 配对依然完整（无孤儿）', findOrphanToolUses(messages).length === 0, `${findOrphanToolUses(messages).length} 个孤儿`])
  }

  // ── C. 模型死循环要工具 ──────────────────────────────────
  {
    const provider = new ScriptedProvider([
      { blocks: [{ type: 'tool_use', id: 'tu_loop', name: 'Read', input: { path: 'package.json' } }] },
    ])
    const messages: Message[] = [createUserMessage('一直读')]
    const r = await runAgent({
      provider,
      model: 'scripted-1',
      system: '',
      tools: new ToolRegistry().register(ReadTool),
      messages,
      maxTurns: 3,
    })
    checks.push(['C maxTurns 拦住死循环', r.stopReason === 'max_turns' && r.turns === 3, `${r.stopReason} / ${r.turns} 轮`])
    checks.push(['C 死循环下配对也不断', findOrphanToolUses(messages).length === 0, `${findOrphanToolUses(messages).length} 个孤儿`])
  }

  // ── D. 模型调了不存在的工具 ──────────────────────────────
  {
    const provider = new ScriptedProvider([
      { blocks: [{ type: 'tool_use', id: 'tu_x', name: '不存在的工具', input: {} }] },
      { blocks: [{ type: 'text', text: '好的，我知道了。' }] },
    ])
    const messages: Message[] = [createUserMessage('随便干点啥')]
    const r = await runAgent({
      provider,
      model: 'scripted-1',
      system: '',
      tools: new ToolRegistry().register(ReadTool),
      messages,
    })
    const body = JSON.stringify(toolResultBlocks(messages))

    checks.push(['D 未知工具不崩，且告知模型', r.stopReason === 'end_turn' && body.includes('未知工具'), r.stopReason])
    checks.push(['D 列出可用工具帮它纠正', body.includes('Read'), '提示了 Read'])
  }

  console.log('\n  冒烟测试 —— 主循环\n')
  let failed = 0
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}  \x1b[2m${detail}\x1b[0m`)
    if (!ok) failed += 1
  }

  console.log(
    failed === 0
      ? '\n  \x1b[32m全部通过。主循环闭环成立 —— 把剧本模型换成真模型，它就能自己干活了。\x1b[0m\n'
      : `\n  \x1b[31m${failed} 项失败\x1b[0m\n`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
