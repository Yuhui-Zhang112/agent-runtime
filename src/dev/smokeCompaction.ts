/**
 * 冒烟测试 · 上下文压缩与离线 Eval（Phase 3 的核心验收）
 *
 * 零 API key、零网络、完全确定性。五组场景：
 *
 *   A 纯函数：触发/跳过/预算/自检五项/纯函数不改入参/策略 fail-closed
 *   B 回滚：历史本来就有孤儿时，压缩必须整套放弃，绝不把坏消息发出去
 *   C 主循环集成：占位符真的发给模型、Trace 记下节省、配对不断、
 *     以及 result.traces 不再为空（Phase 1 遗留 bug 的回归断言）
 *   D Trace 持久化：落盘 → 回放、坏行容错、写盘失败不影响主流程
 *   E 离线 Eval：任务集可复现、A/B/C 三组结论稳定、两次运行逐字段一致
 *
 *   npm run smoke:compaction
 */

import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  compactMessages,
  countPlaceholders,
  resolveCompactionPolicy,
  totalTokens,
  toCompactionEvent,
  PLACEHOLDER_PREFIX,
  type CompactionEvent,
  type CompactionPolicy,
} from '../core/compaction.js'
import {
  TraceStore,
  readTraceFile,
  summarizeTraces,
  compactionTimeline,
} from '../core/traceStore.js'
import { runAgent, findOrphanToolUses } from '../core/runAgent.js'
import { ToolRegistry } from '../core/tool.js'
import { ReadTool } from '../tools/ReadTool.js'
import {
  createAssistantMessage,
  createUserMessage,
  findOrphanToolUseIds,
  type ContentBlock,
  type Message,
} from '../types/message.js'
import { ScriptedProvider } from './scriptedModel.js'
import { EvalProvider, flattenHistory, estimateRequestTokens } from './evalModel.js'
import { buildTasks, materialize, cleanup, TASK_COUNT } from './evalTasks.js'
import { runExperiment, conclude, renderReport } from './evalCompaction.js'
import { AgentServer } from '../server/http.js'
import { JsonlLogger } from '../server/log.js'
import { loadConfig } from '../server/config.js'

type Check = [string, boolean, string?]
const checks: Check[] = []
const ck = (name: string, ok: boolean, detail?: string): void => {
  checks.push([name, ok, detail])
}

// ── 构造一段带大块 tool_result 的真实历史 ─────────────────────

const BIG = 'const value = 1234567890; // ' + 'x'.repeat(3800)
const POLICY: Partial<CompactionPolicy> = {
  enabled: true,
  triggerTokens: 1_000,
  targetTokens: 400,
  protectRecentMessages: 2,
  minResultChars: 500,
  maxCollapsed: 10,
  recoverable: true,
}

/** 每轮 = 一条 assistant(tool_use) + 一条 user(tool_result)，uuid 链连贯 */
function makeHistory(rounds: number, content = BIG): Message[] {
  const out: Message[] = [createUserMessage('请读文件并回答')]
  for (let i = 1; i <= rounds; i += 1) {
    const parent = out.at(-1)!.uuid
    out.push(
      createAssistantMessage(
        [{ type: 'tool_use', id: `tu_${i}`, name: 'Read', input: { path: `file-${i}.txt` } }],
        parent,
        { model: 'test' },
      ),
    )
    const blocks: ContentBlock[] = [
      { type: 'tool_result', tool_use_id: `tu_${i}`, content: `${content}\nSECRET-VALUE-${i}` },
    ]
    out.push(createUserMessage(blocks, out.at(-1)!.uuid))
  }
  return out
}

const resultsText = (messages: Message[]): string =>
  messages
    .flatMap((m) =>
      m.type === 'user' && Array.isArray(m.message.content)
        ? m.message.content.map((b) => (b.type === 'tool_result' && typeof b.content === 'string' ? b.content : ''))
        : [],
    )
    .join('\n')

async function main(): Promise<void> {
  // ── A. 纯函数基本行为 ───────────────────────────────────────
  {
    const history = makeHistory(6)
    const before = JSON.stringify(history)

    ck('A 未启用 → disabled', compactMessages(history, { ...POLICY, enabled: false }).reason === 'disabled')
    ck(
      'A 低于阈值 → below-threshold',
      compactMessages(history, { ...POLICY, triggerTokens: 999_999, targetTokens: 999_998 }).reason ===
        'below-threshold',
    )
    ck(
      'A 短结果不值得压 → no-candidate',
      compactMessages(history, { ...POLICY, minResultChars: 999_999 }).reason === 'no-candidate',
    )

    const r = compactMessages(history, POLICY)
    ck('A 正常触发 → ok', r.applied && r.reason === 'ok', r.reason)
    ck('A 确实省了 token', r.savedTokens > 0 && r.afterTokens < r.beforeTokens, `${r.beforeTokens} → ${r.afterTokens}`)
    ck('A savedTokens 与前后差一致', r.savedTokens === r.beforeTokens - r.afterTokens)
    ck('A triggerTokens 记在结果里', r.triggerTokens === 1_000)
    ck('A 入参数组未被修改（纯函数）', JSON.stringify(history) === before)
    ck('A 返回的是新数组', r.messages !== history)
    ck('A 消息条数不变', r.messages.length === history.length, `${r.messages.length} 条`)
    ck('A 折叠条目非空', r.collapsed.length > 0, `${r.collapsed.length} 条`)
    ck('A 记下了工具名', r.collapsed.every((c) => c.toolName === 'Read'))
    ck('A 记下了原路径', r.collapsed.every((c) => c.path?.startsWith('file-') === true))
    ck('A 每条折叠都记了节省量', r.collapsed.every((c) => c.savedTokens > 0))
    ck('A 五项自检全过', Object.values(r.selfCheck).every(Boolean), JSON.stringify(r.selfCheck))
    ck('A 预算达标标记合理', r.budgetMet === (r.afterTokens <= 400))

    const text = resultsText(r.messages)
    ck('A 占位符写进 tool_result', text.includes(PLACEHOLDER_PREFIX))
    ck('A 可恢复占位符带原路径', text.includes('Read(path="file-1.txt")'))
    ck('A 可恢复占位符声明原文未删除', text.includes('原文未删除'))
    ck('A 被折叠的块没被删（配对结构还在）', countPlaceholders(r.messages) === r.collapsed.length)
    ck('A 首条消息引用不变', r.messages[0] === history[0])
    ck('A 最近 2 条引用不变', r.messages.slice(-2).every((m, i) => m === history[history.length - 2 + i]))
    ck('A uuid / parentUuid 链完整不变', r.messages.every((m, i) => m.uuid === history[i]!.uuid && m.parentUuid === history[i]!.parentUuid))
    ck('A 压缩后无孤儿 tool_use', findOrphanToolUseIds(r.messages).length === 0)
    ck('A totalTokens 与实际一致', totalTokens(r.messages) === r.afterTokens)

    const lossy = compactMessages(history, { ...POLICY, recoverable: false })
    ck('A 不可恢复占位符声明不可恢复', resultsText(lossy.messages).includes('内容不可恢复'))
    ck('A 不可恢复占位符不提示重读', !resultsText(lossy.messages).includes('Read(path='))

    const twice = compactMessages(r.messages, POLICY)
    ck('A 已折过的不会二次压缩', twice.reason === 'no-candidate' && !twice.applied, twice.reason)

    const one = compactMessages(history, { ...POLICY, maxCollapsed: 1 })
    ck('A maxCollapsed 生效', one.collapsed.length === 1, `${one.collapsed.length} 条`)

    let threw = 0
    for (const bad of [
      { ...POLICY, targetTokens: 1_000 },
      { ...POLICY, protectRecentMessages: 0 },
      { ...POLICY, triggerTokens: -1 },
      { ...POLICY, maxCollapsed: 1.5 },
    ]) {
      try {
        resolveCompactionPolicy(bad)
      } catch {
        threw += 1
      }
    }
    ck('A 非法策略 fail-closed 全部抛错', threw === 4, `${threw}/4`)

    const ev = toCompactionEvent(3, r, true)
    ck('A 压缩事件字段完整', ev.turn === 3 && ev.applied && ev.recoverable && ev.collapsedCount === r.collapsed.length)
  }

  // ── B. 自检回滚 ────────────────────────────────────────────
  {
    const history = makeHistory(6)
    // 人为制造一个孤儿：加一条只有 tool_use、没有 tool_result 的 assistant 消息
    history.push(
      createAssistantMessage(
        [{ type: 'tool_use', id: 'tu_orphan', name: 'Read', input: { path: 'x.txt' } }],
        history.at(-1)!.uuid,
        { model: 'test' },
      ),
    )
    const before = JSON.stringify(history)
    const r = compactMessages(history, POLICY)
    ck('B 坏历史触发自检失败', r.reason === 'self-check-failed' && !r.applied, r.reason)
    ck('B 自检明细指出是配对问题', r.selfCheck.pairing === false)
    ck('B 整套回滚，历史一字未改', JSON.stringify(r.messages) === before && JSON.stringify(history) === before)
    ck('B 回滚后 savedTokens 归零', r.savedTokens === 0 && r.afterTokens === r.beforeTokens)
  }

  // ── C. 主循环集成 ──────────────────────────────────────────
  {
    const provider = new ScriptedProvider([
      { blocks: [{ type: 'tool_use', id: 'tu_a', name: 'Read', input: { path: 'package.json' } }] },
      { blocks: [{ type: 'tool_use', id: 'tu_b', name: 'Read', input: { path: 'README.md' } }] },
      { blocks: [{ type: 'text', text: '完成' }] },
    ])
    const messages: Message[] = [createUserMessage('读两个文件')]
    const events: CompactionEvent[] = []
    const result = await runAgent({
      provider,
      model: 'claude-sonnet-4',
      system: 'test',
      tools: new ToolRegistry().register(ReadTool),
      messages,
      compaction: { ...POLICY, triggerTokens: 100, targetTokens: 50, minResultChars: 200, protectRecentMessages: 1 },
      onCompaction: (e) => events.push(e),
    })

    ck('C 主循环正常结束', result.stopReason === 'end_turn', result.stopReason)
    ck('C 压缩事件推给回调', events.length === result.turns, `${events.length} 条`)
    ck('C 至少有一轮真的压缩了', events.some((e) => e.applied === true))
    ck('C Trace 记下本轮节省', result.traces.some((t) => t.compactionSavedTokens > 0))
    ck('C Trace 每轮都有压缩判定', result.traces.every((t) => t.compactionEvents.length === 1))
    ck('C ★ result.traces 不再为空（Phase 1 bug 回归）', result.traces.length === result.turns, `${result.traces.length}/${result.turns}`)
    ck('C 占位符真的发给模型了', provider.requests.some((r) => flattenHistory(r.messages).includes(PLACEHOLDER_PREFIX)))
    ck('C 压缩后配对不断', findOrphanToolUses(messages).length === 0)
    ck('C 压缩后仍能走到最终答案', result.finalText === '完成', result.finalText)

    // 不传策略 = Phase 1/2 行为完全不变
    const plain = new ScriptedProvider([{ blocks: [{ type: 'text', text: 'ok' }] }])
    const plainResult = await runAgent({
      provider: plain,
      model: 'claude-sonnet-4',
      system: 'test',
      tools: new ToolRegistry().register(ReadTool),
      messages: [createUserMessage('hi')],
    })
    ck('C 不传压缩时行为不变', plainResult.stopReason === 'end_turn' && plainResult.traces.every((t) => t.compactionEvents.length === 0 && t.compactionSavedTokens === 0))
  }

  // ── D. Trace 持久化 ────────────────────────────────────────
  {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-trace-'))
    try {
      const store = new TraceStore(dir, 'run-smoke')
      // 让主循环跑两轮
      const twoTurns = new ScriptedProvider([
        { blocks: [{ type: 'tool_use', id: 'tu_d', name: 'Read', input: { path: 'package.json' } }] },
        { blocks: [{ type: 'text', text: 'done' }] },
      ])
      await runAgent({
        provider: twoTurns,
        model: 'claude-sonnet-4',
        system: 'test',
        tools: new ToolRegistry().register(ReadTool),
        messages: [createUserMessage('go')],
        tracer: store,
        compaction: POLICY,
      })

      ck('D TraceStore 收到每轮记录', store.records.length === 2, `${store.records.length} 条`)
      ck('D 落盘文件存在', store.path !== null && readFileSync(store.path!, 'utf8').split('\n').filter(Boolean).length === 2)
      const replayed = readTraceFile(store.path!)
      ck('D 回放条数一致', replayed.length === 2)
      ck('D 回放内容一致', JSON.stringify(replayed.map((r) => r.trace)) === JSON.stringify(store.traces))
      ck('D runId / seq 完整', replayed[0]!.runId === 'run-smoke' && replayed[1]!.seq === 2)

      // 坏行容错：追加一行半截 JSON
      writeFileSync(store.path!, '{broken json\n', { flag: 'a' })
      ck('D 坏行跳过而不是整个文件报废', readTraceFile(store.path!).length === 2)

      const s = summarizeTraces(store.traces)
      ck('D 汇总求和正确', s.turns === 2 && s.inputTokens === store.traces.reduce((a, t) => a + t.inputTokens, 0))
      ck('D 汇总含压缩字段', typeof s.compactionSavedTokens === 'number' && typeof s.compactions === 'number')
      ck('D 时间线抽出压缩事件', compactionTimeline(store.traces).length === 2)

      // 写盘失败不许影响主流程：把日志目录指到一个普通文件的子路径（必失败）
      let ok = true
      const fileAsDir = join(dir, 'a-file')
      writeFileSync(fileAsDir, 'x')
      const broken = new TraceStore(join(fileAsDir, 'child'), 'run-bad')
      try {
        broken.onTurn(store.traces[0]!)
      } catch {
        ok = false
      }
      ck('D 写盘失败被吞掉，内存副本仍在', ok && broken.records.length === 1)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // ── E. 离线 Eval 可复现 ────────────────────────────────────
  {
    ck('E 任务集固定种子完全可复现', JSON.stringify(buildTasks(TASK_COUNT)) === JSON.stringify(buildTasks(TASK_COUNT)))
    const tasks = buildTasks(1)
    const fx = materialize(tasks)
    try {
      const p = new EvalProvider({ task: tasks[0]!, allowRecovery: true })
      const req = {
        model: 'claude-sonnet-4',
        system: 's'.repeat(40),
        messages: [createUserMessage('x'.repeat(400))],
        tools: [{ name: 'Read', description: 'd', input_schema: {} }],
        maxTokens: 100,
      }
      const small = estimateRequestTokens(req)
      const big = estimateRequestTokens({ ...req, messages: [createUserMessage('x'.repeat(4000))] })
      ck('E input_tokens 随历史真实变化', big > small, `${small} → ${big}`)

      const streamed: string[] = []
      for await (const ev of p.stream(req)) streamed.push(ev.type)
      ck('E 评测模型产出标准流事件', streamed.includes('message_start') && streamed.includes('message_stop'))
      ck('E 评测模型记下真实 input_tokens', p.inputTokens[0] === small && p.calls === 1)

      ck('E flattenHistory 能读到埋值', flattenHistory(makeHistory(1)).includes('SECRET-VALUE-1'))
      const compressed = compactMessages(makeHistory(6), POLICY)
      ck('E 压缩确实发生', compressed.applied, compressed.reason)
      ck('E 占位符历史里读不到埋值', !flattenHistory(compressed.messages).includes('SECRET-VALUE-1'))
    } finally {
      cleanup(fx)
    }

    const first = await runExperiment(3)
    const A = first.strategies.find((s) => s.key === 'A')!
    const B = first.strategies.find((s) => s.key === 'B')!
    const C = first.strategies.find((s) => s.key === 'C')!
    ck('E 基线组全部答对', A.success === 3 && A.compactions === 0, `${A.success}/3`)
    ck('E 不可恢复对照组全部丢失', B.success === 0 && B.lossRate === 1, `${B.success}/3`)
    ck('E 可恢复组全部答对', C.success === 3 && C.lossRate === 0, `${C.success}/3`)
    ck('E 可恢复组确实省了钱', C.costUSD < A.costUSD, `${C.costUSD.toFixed(4)} < ${A.costUSD.toFixed(4)}`)
    ck('E 可恢复组付出额外重读', C.recoveryCalls === 3 && C.turns > A.turns, `${C.recoveryCalls} 次`)
    ck('E 参数扫描覆盖了两个维度', first.sweep.some((p) => p.dimension === 'threshold') && first.sweep.some((p) => p.dimension === 'protect'))
    ck('E 扫描里出现「压缩反而更贵」的参数点', first.sweep.some((p) => p.costReductionPct < 0))
    const c = conclude(first)
    ck('E 结论计算方向正确', c.costReductionPct > 0 && c.bLossPctPoints > c.lossPctPoints)

    const second = await runExperiment(3)
    const core = (s: typeof first): string => JSON.stringify({ strategies: s.strategies, sweep: s.sweep })
    ck('E ★ 两次独立实验逐字段一致', core(first) === core(second))
    ck('E 报告能渲染且含关键数字', renderReport(first, c, true).includes(c.costReductionPct.toFixed(1)))
  }

  // ── F. 服务形态：SSE 压缩事件 + Trace 落盘 ──────────────────
  {
    const dir = mkdtempSync(join(tmpdir(), 'agent-runtime-http-trace-'))
    let server: AgentServer | null = null
    try {
      const cfg = loadConfig({
        ...process.env,
        PROVIDER: 'openai',
        API_KEY: 'test-key',
        CWD: join(import.meta.dirname, '..', '..'),
        HOST: '127.0.0.1',
        PORT: '0',
        AUTH_TOKEN: '',
        LOG_DIR: '',
        TRACE_DIR: dir,
        COMPACTION: 'on',
        COMPACTION_TRIGGER_TOKENS: '100',
        COMPACTION_TARGET_TOKENS: '50',
        COMPACTION_PROTECT_RECENT: '1',
        COMPACTION_MIN_RESULT_CHARS: '200',
        PERMISSION_MODE: 'default',
        PERMISSION_RULES: '',
      } as NodeJS.ProcessEnv)

      const provider = new ScriptedProvider([
        { blocks: [{ type: 'tool_use', id: 'tu_f1', name: 'Read', input: { path: 'package.json' } }] },
        { blocks: [{ type: 'tool_use', id: 'tu_f2', name: 'Read', input: { path: 'README.md' } }] },
        { blocks: [{ type: 'text', text: 'done' }] },
      ])
      server = new AgentServer({
        config: cfg,
        provider,
        tools: new ToolRegistry().register(ReadTool),
        logger: new JsonlLogger(null),
      })
      const { port } = await server.listen(0, '127.0.0.1')
      const base = `http://127.0.0.1:${port}`

      const policyRes = await fetch(`${base}/v1/compaction`)
      const policyJson = (await policyRes.json()) as { enabled: boolean; policy: { triggerTokens: number } }
      ck(
        'F 服务暴露当前压缩策略',
        policyRes.status === 200 && policyJson.enabled === true && policyJson.policy.triggerTokens === 100,
      )

      const createRes = await fetch(`${base}/v1/sessions`, { method: 'POST' })
      const session = (await createRes.json()) as { id: string }
      const runRes = await fetch(`${base}/v1/sessions/${session.id}/runs`, {
        method: 'POST',
        body: JSON.stringify({ text: '读两个文件' }),
      })
      const raw = await runRes.text()

      const sseEvents: Array<{ event: string; data: Record<string, unknown> }> = []
      for (const block of raw.split('\n\n')) {
        const ev = /^event: (.+)$/m.exec(block)
        const dt = /^data: (.+)$/m.exec(block)
        if (!ev || !dt) continue
        try {
          sseEvents.push({ event: ev[1]!, data: JSON.parse(dt[1]!) as Record<string, unknown> })
        } catch {
          /* 忽略半行 */
        }
      }

      const compactionEvents = sseEvents.filter((e) => e.event === 'compaction')
      ck('F SSE 推出每轮压缩判定', compactionEvents.length === 3, `${compactionEvents.length} 条`)
      ck('F 至少一轮真的压缩了', compactionEvents.some((e) => e.data.applied === true))
      const done = sseEvents.find((e) => e.event === 'done')
      ck('F done 带累计节省', typeof done?.data.compactionSavedTokens === 'number' && (done!.data.compactionSavedTokens as number) > 0)
      ck('F done 带 Trace 文件路径', typeof done?.data.traceFile === 'string' && (done!.data.traceFile as string).startsWith(dir))
      ck('F Trace 真的落盘且可回放', readTraceFile(done!.data.traceFile as string).length === (done!.data.turns as number))
      ck('F 服务端配对不断（正常结束）', done?.data.stopReason === 'end_turn', String(done?.data.stopReason))
    } finally {
      await server?.close()
      rmSync(dir, { recursive: true, force: true })
    }
  }

  // ── 汇总 ───────────────────────────────────────────────────
  console.log('\n  冒烟测试 —— 上下文压缩与离线 Eval\n')
  let failed = 0
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}  \x1b[2m${detail ?? ''}\x1b[0m`)
    if (!ok) failed += 1
  }
  console.log(
    failed === 0
      ? `\n  \x1b[32m全部通过（${checks.length}/${checks.length}）。压缩闭环成立 —— 可恢复、可回滚、可量化、可复现。\x1b[0m\n`
      : `\n  \x1b[31m${failed} 项失败\x1b[0m\n`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
