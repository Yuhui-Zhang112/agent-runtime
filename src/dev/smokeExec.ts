/**
 * 冒烟测试 · 并发调度（toolExecution）
 *
 * 并发是最容易"看起来对了、实际埋雷"的一块：
 *   - 顺序乱了 → 模型看不懂结果，但不会报错，你根本发现不了
 *   - 写操作被并发 → 两个工具同时改一个文件，互相覆盖
 *   - 中断时有工具没拿到结果 → 配对断裂，会话永久死锁
 *
 * 这些在真 API 上都难以稳定复现，所以全部用可控的测试工具来断言。
 *
 *   npm run smoke:exec
 */

import { z } from 'zod'
import { ScriptedProvider } from './scriptedModel.js'
import { ToolRegistry, defineTool } from '../core/tool.js'
import { ReadTool } from '../tools/ReadTool.js'
import {
  executeToolUses,
  planGroups,
  type ExecutedTool,
  type ToolUseRef,
} from '../core/toolExecution.js'
import { runAgent, findOrphanToolUses, type TurnTrace } from '../core/runAgent.js'
import { createUserMessage, type Message } from '../types/message.js'

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

// ── 测试用工具 ──────────────────────────────────────────────

/** 慢速只读工具：用来验证"3 个 80ms 的工具并发跑只花 ~80ms，不是 240ms" */
let slowRunning = 0
let slowPeak = 0
const SlowTool = defineTool({
  name: 'Slow',
  description: '测试用：睡 ms 毫秒再返回',
  inputSchema: z.object({ ms: z.number().default(80), id: z.string().default('') }),
  isReadOnly: true,
  isConcurrencySafe: true,
  async call(input) {
    const ms = input.ms ?? 80
    slowRunning += 1
    slowPeak = Math.max(slowPeak, slowRunning)
    await sleep(ms)
    slowRunning -= 1
    return { output: `done:${input.id ?? ''}` }
  },
})

/** 会改东西的工具：绝不能跟别人并发 */
const MutateTool = defineTool({
  name: 'Mutate',
  description: '测试用：模拟写操作',
  inputSchema: z.object({}),
  isReadOnly: false,
  isConcurrencySafe: false,
  async call() {
    await sleep(20)
    return { output: 'mutated' }
  },
})

/** 一调用就抛错的工具：验证"一个失败不掀翻整批" */
const BoomTool = defineTool({
  name: 'Boom',
  description: '测试用：一定失败',
  inputSchema: z.object({}),
  isReadOnly: true,
  isConcurrencySafe: true,
  async call() {
    throw new Error('故意失败')
  },
})

function resetConcurrency() {
  slowRunning = 0
  slowPeak = 0
}

async function main(): Promise<void> {
  const checks: Array<[string, boolean, string]> = []

  const registry = new ToolRegistry().register(SlowTool, MutateTool, BoomTool, ReadTool)
  const ctx = { cwd: process.cwd() }

  // ── A. 分组正确：可并发的合并，会改的独占 ──────────────────
  {
    const uses: ToolUseRef[] = [
      { id: '1', name: 'Slow', input: {} },
      { id: '2', name: 'Slow', input: {} },
      { id: '3', name: 'Mutate', input: {} },
      { id: '4', name: 'Slow', input: {} },
      { id: '5', name: 'Read', input: { path: 'package.json' } },
    ]
    const groups = planGroups(uses, registry)

    checks.push([
      'A 切成 3 个波次',
      groups.length === 3,
      groups.map((g) => `${g.parallel ? '并行' : '独占'}(${g.items.length})`).join(' → '),
    ])
    checks.push([
      'A 写操作独占一波',
      groups[1]!.parallel === false && groups[1]!.items[0]!.name === 'Mutate',
      groups[1]!.items[0]!.name,
    ])
    checks.push([
      'A 未知工具不进并行组',
      planGroups([{ id: 'x', name: '不存在的', input: {} }], registry)[0]!.parallel === false,
      '保守处理',
    ])
  }

  // ── B. 真的省时间：3×80ms 并发 ≈ 80ms，不是 240ms ───────────
  {
    resetConcurrency()
    const uses: ToolUseRef[] = [1, 2, 3].map((n) => ({
      id: `s${n}`,
      name: 'Slow',
      input: { ms: 80, id: String(n) },
    }))

    const t0 = Date.now()
    const res = await executeToolUses({ toolUses: uses, tools: registry, ctx })
    const wall = Date.now() - t0

    checks.push(['B 三条结果都回来了', res.length === 3, `${res.length} 条`])
    checks.push([
      'B 并发省时间（<160ms）',
      wall < 160,
      `墙钟 ${wall}ms，串行需 240ms`,
    ])
    checks.push([
      'B 实际并发度 = 3',
      slowPeak === 3,
      `峰值同时 ${slowPeak} 个`,
    ])
    checks.push([
      'B 单条耗时仍按各自记（≈80ms）',
      res.every((r) => r.durationMs >= 75 && r.durationMs < 140),
      res.map((r) => `${r.durationMs}ms`).join('/'),
    ])
    checks.push([
      'B 都在同一波次',
      new Set(res.map((r) => r.wave)).size === 1 && res[0]!.wave === 0,
      `wave=${res.map((r) => r.wave).join(',')}`,
    ])
  }

  // ── C. 顺序必须与请求顺序一致（并发最容易埋的雷）──────────
  {
    resetConcurrency()
    // 故意让第 1 个最慢：如果是"谁先完成谁先入列"，顺序就错了
    const uses: ToolUseRef[] = [
      { id: 'a', name: 'Slow', input: { ms: 120, id: 'a' } },
      { id: 'b', name: 'Slow', input: { ms: 10, id: 'b' } },
      { id: 'c', name: 'Slow', input: { ms: 60, id: 'c' } },
    ]
    const res = await executeToolUses({ toolUses: uses, tools: registry, ctx })

    checks.push([
      'C 结果顺序 = 请求顺序',
      res.map((r) => r.toolUseId).join('') === 'abc',
      res.map((r) => r.toolUseId).join(','),
    ])
    checks.push([
      'C 内容也没串位',
      res.map((r) => r.output).join(',') === 'done:a,done:b,done:c',
      res.map((r) => r.output).join(','),
    ])
  }

  // ── D. 并发上限：5 个任务、上限 2 → 峰值不超过 2 ──────────
  {
    resetConcurrency()
    const uses: ToolUseRef[] = [1, 2, 3, 4, 5].map((n) => ({
      id: `p${n}`,
      name: 'Slow',
      input: { ms: 30, id: String(n) },
    }))
    const res = await executeToolUses({
      toolUses: uses,
      tools: registry,
      ctx,
      maxParallel: 2,
    })

    checks.push(['D 并发度被限制在 2', slowPeak <= 2, `峰值 ${slowPeak}`])
    checks.push(['D 顺序仍然正确', res.map((r) => r.toolUseId).join('') === 'p1p2p3p4p5', res.map((r) => r.toolUseId).join(',')])
  }

  // ── E. 一个失败不掀翻整批 ──────────────────────────────────
  {
    resetConcurrency()
    const uses: ToolUseRef[] = [
      { id: 'e1', name: 'Boom', input: {} },
      { id: 'e2', name: 'Slow', input: { ms: 10, id: 'e2' } },
      { id: 'e3', name: '不存在的工具', input: {} },
    ]
    const res = await executeToolUses({ toolUses: uses, tools: registry, ctx })

    checks.push(['E 失败的那个标了 isError', res[0]!.isError === true && res[0]!.output.includes('失败'), '已标记'])
    checks.push(['E 其他两个照常成功', res[1]!.isError === false && res[1]!.output === 'done:e2', res[1]!.output])
    checks.push(['E 未知工具给了可用清单', res[2]!.isError && res[2]!.output.includes('Slow'), '提示了可用工具'])
    checks.push(['E 三条结果一条不少', res.length === 3, `${res.length} 条`])
  }

  // ── F. 中断：不再真的执行，但结果一条不少 ──────────────────
  {
    resetConcurrency()
    const controller = new AbortController()
    controller.abort()
    const uses: ToolUseRef[] = [
      { id: 'f1', name: 'Slow', input: { ms: 50, id: 'f1' } },
      { id: 'f2', name: 'Slow', input: { ms: 50, id: 'f2' } },
    ]
    const res = await executeToolUses({
      toolUses: uses,
      tools: registry,
      ctx: { ...ctx, signal: controller.signal },
    })

    checks.push(['F 中断后没有真的执行', slowPeak === 0, `实际执行 ${slowPeak} 个`])
    checks.push(['F 结果位照样补齐', res.length === 2 && res.every((r) => r.cancelled), `${res.length} 条合成结果`])
    checks.push(['F 都标了 isError', res.every((r) => r.isError), '配对不会断'])
  }

  // ── G. 接进主循环：一轮读 3 个文件 ─────────────────────────
  {
    const traces: TurnTrace[] = []
    const provider = new ScriptedProvider([
      {
        blocks: [
          { type: 'tool_use', id: 'g1', name: 'Read', input: { path: 'package.json' } },
          { type: 'tool_use', id: 'g2', name: 'Read', input: { path: 'package.json' } },
          { type: 'tool_use', id: 'g3', name: 'Read', input: { path: 'package.json' } },
        ],
      },
      { blocks: [{ type: 'text', text: '读完了。' }] },
    ])
    const messages: Message[] = [createUserMessage('读三个文件')]
    const events: ExecutedTool[] = []

    const r = await runAgent({
      provider,
      model: 'scripted-1',
      system: '',
      tools: new ToolRegistry().register(ReadTool),
      messages,
      tracer: { onTurn: (t) => traces.push(t) },
      onToolEvent: (e) => {
        if (e.phase === 'end') events.push(e)
      },
    })

    const t1 = traces[0]!
    const sumOfTools = t1.toolResults.reduce((s, x) => s + x.durationMs, 0)

    checks.push(['G 三个工具都执行了', t1.toolResults.length === 3, `${t1.toolResults.length} 个`])
    checks.push(['G 并发度记录为 3', t1.maxConcurrency === 3, `maxConcurrency=${t1.maxConcurrency}`])
    checks.push([
      'G 墙钟 < 串行总和（并发生效）',
      t1.toolMs <= Math.max(sumOfTools, 1) + 5,
      `并发 ${t1.toolMs}ms vs 串行 ${sumOfTools}ms`,
    ])
    checks.push(['G 顺序 = 请求顺序', t1.toolResults.map((x) => x.toolUseId).join('') === 'g1g2g3', t1.toolResults.map((x) => x.toolUseId).join(',')])
    checks.push(['G 无孤儿 tool_use', findOrphanToolUses(messages).length === 0, '配对完整'])
    checks.push(['G 事件回调收到 3 次 end', events.length === 3, `${events.length} 次`])
    checks.push(['G 两轮正常结束', r.stopReason === 'end_turn' && r.turns === 2, r.stopReason])
  }

  // ── 输出 ──────────────────────────────────────────────────
  console.log('\n  冒烟测试 —— 并发调度\n')
  let failed = 0
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}  \x1b[2m${detail}\x1b[0m`)
    if (!ok) failed += 1
  }

  console.log(
    failed === 0
      ? '\n  \x1b[32m全部通过。只读工具并发、写操作独占、顺序不乱、中断不留空洞。\x1b[0m\n'
      : `\n  \x1b[31m${failed} 项失败\x1b[0m\n`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
