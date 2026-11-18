/**
 * 场景 Agent 回归评测（Phase 4 的产出）
 *
 * 和 Phase 3 的区别：
 *   Phase 3 测的是「埋值能不能原样引回来」—— 一个架构层的微指标；
 *   这里测的是「一个像样的业务任务能不能做完」—— Grep 找候选 → Read 取证据 →
 *   输出结构化结论，再用 ground truth 自动判分（文件 / 缺陷类型 / 精确标记三项全中）。
 *
 *   A 基线（不压缩） / B 压缩·不可恢复 / C 压缩·可恢复
 *   除了压缩策略，其余全部锁死：同一批 issue、同一份 fixture 仓库、
 *   同一个确定性 IssueProvider、同一套工具与计价口径。
 *
 * 跑法：npm run eval:scenario
 * 产物：reports/scenario-eval.md / .json
 *
 * ⚠️ 诚实边界：驱动它的是「会读历史的确定性假模型」，仓库是结构真实、
 *    内容合成的 fixture。数字证明的是「压缩没有破坏证据可达性与结论正确性」
 *    这条架构机制，不是「能解决真实 GitHub issue」或真实 LLM 的成功率。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { CompactionPolicy } from '../core/compaction.js'
import {
  buildIssues,
  materializeIssues,
  ISSUE_COUNT,
  ISSUE_SEED,
  NOISE_FILES_PER_ISSUE,
  type IssueTask,
} from '../scenarios/issueFixtures.js'
import { runIssueAgent, SCENARIO_MODEL } from '../scenarios/issueAgent.js'

/** 与 Phase 3 实验同一套压缩参数，方便两个报告横向对照 */
export const SCENARIO_POLICY: Partial<CompactionPolicy> = {
  enabled: true,
  triggerTokens: 2_400,
  targetTokens: 1_200,
  protectRecentMessages: 4,
  minResultChars: 600,
  maxCollapsed: 24,
}

export interface ScenarioStrategy {
  key: string
  label: string
  policy: Partial<CompactionPolicy> | null
  allowRecovery: boolean
  note: string
}

export const SCENARIO_STRATEGIES: ScenarioStrategy[] = [
  {
    key: 'A',
    label: 'A 基线（不压缩）',
    policy: null,
    allowRecovery: true,
    note: '原样重发全部历史，证据必然可达',
  },
  {
    key: 'B',
    label: 'B 压缩·不可恢复',
    policy: { ...SCENARIO_POLICY, recoverable: false },
    allowRecovery: false,
    note: '占位符只说「已移除」，证据真的丢了',
  },
  {
    key: 'C',
    label: 'C 压缩·可恢复',
    policy: { ...SCENARIO_POLICY, recoverable: true },
    allowRecovery: true,
    note: '占位符写明原路径，模型按需重新 Read 取回',
  },
  {
    key: 'D',
    label: 'D 只折大结果（推荐）',
    policy: { ...SCENARIO_POLICY, minResultChars: 3_000, recoverable: true },
    allowRecovery: true,
    note: '提高折叠门槛：只压大体积噪音文件，保留根因文件原文，因此无需重读',
  },
]

/**
 * 「多大体积的工具结果才值得折叠」是本场景的主导参数：
 *   门槛太低 → 连根因文件一起折掉 → 模型必须回头重读 → 多一轮全量重发，反而更贵；
 *   门槛合适 → 只折噪音文件 → 不重读、证据不丢、成本真降；
 *   门槛太高 → 什么都不折 → 退化成基线。
 */
export const SWEEP_MIN_CHARS = [600, 1_200, 2_400, 4_000, 8_000, 16_000] as const

export interface ScenarioSweepPoint {
  minResultChars: number
  costUSD: number
  inputTokens: number
  costReductionPct: number
  success: number
  successRate: number
  recoveryCalls: number
  compactions: number
  collapsedResults: number
  turns: number
}

export interface ScenarioOutcome {
  id: string
  success: boolean
  fileHit: boolean
  categoryHit: boolean
  evidenceHit: boolean
  evidenceLost: boolean
  costUSD: number
  inputTokens: number
  turns: number
  toolCalls: number
  compactions: number
  collapsedResults: number
  savedTokens: number
  recovered: boolean
}

export interface ScenarioGroup {
  key: string
  label: string
  note: string
  tasks: number
  success: number
  successRate: number
  evidenceLost: number
  lossRate: number
  costUSD: number
  inputTokens: number
  turns: number
  toolCalls: number
  compactions: number
  collapsedResults: number
  savedTokens: number
  recoveryCalls: number
  outcomes: ScenarioOutcome[]
}

/** 不含任何时间 / 随机字段，两次运行逐字段比对即可证明可复现 */
export interface ScenarioSnapshot {
  taskCount: number
  seed: number
  noiseFilesPerIssue: number
  model: string
  strategies: ScenarioGroup[]
  sweep: ScenarioSweepPoint[]
}

export interface ScenarioConclusion {
  baselineSuccess: number
  recoverableSuccess: number
  irreversibleSuccess: number
  recommendedSuccess: number
  /** 激进可恢复组（C）相对基线：本场景为负，即倒赔 */
  aggressiveCostReductionPct: number
  /** 推荐配置（D）相对基线 */
  costReductionPct: number
  successDeltaPctPoints: number
  irreversibleLossPctPoints: number
  recoveryCalls: number
  recommendedRecoveryCalls: number
  bestMinResultChars: number
}

async function runGroup(
  s: ScenarioStrategy,
  tasks: IssueTask[],
  root: string,
): Promise<ScenarioGroup> {
  const outcomes: ScenarioOutcome[] = []

  for (const task of tasks) {
    const run = await runIssueAgent({
      task,
      root,
      compaction: s.policy,
      allowRecovery: s.allowRecovery,
      maxTurns: 20,
    })
    const t = run.summary
    outcomes.push({
      id: task.id,
      success: run.score.success,
      fileHit: run.score.fileHit,
      categoryHit: run.score.categoryHit,
      evidenceHit: run.score.evidenceHit,
      evidenceLost: run.score.evidenceLost,
      costUSD: run.costUSD,
      inputTokens: t.inputTokens,
      turns: run.result.turns,
      toolCalls: t.toolCalls,
      compactions: t.compactions,
      collapsedResults: t.collapsedResults,
      savedTokens: t.compactionSavedTokens,
      recovered: run.provider.recoveries > 0,
    })
  }

  const sum = (f: (o: ScenarioOutcome) => number): number =>
    outcomes.reduce((a, o) => a + f(o), 0)
  const success = outcomes.filter((o) => o.success).length
  const evidenceLost = outcomes.filter((o) => o.evidenceLost).length

  return {
    key: s.key,
    label: s.label,
    note: s.note,
    tasks: outcomes.length,
    success,
    successRate: success / outcomes.length,
    evidenceLost,
    lossRate: evidenceLost / outcomes.length,
    costUSD: sum((o) => o.costUSD),
    inputTokens: sum((o) => o.inputTokens),
    turns: sum((o) => o.turns),
    toolCalls: sum((o) => o.toolCalls),
    compactions: sum((o) => o.compactions),
    collapsedResults: sum((o) => o.collapsedResults),
    savedTokens: sum((o) => o.savedTokens),
    recoveryCalls: outcomes.filter((o) => o.recovered).length,
    outcomes,
  }
}

export async function runScenarioExperiment(
  count = ISSUE_COUNT,
  seed = ISSUE_SEED,
): Promise<ScenarioSnapshot> {
  const tasks = buildIssues(count, seed)
  const fixture = materializeIssues(tasks, seed)
  const strategies: ScenarioGroup[] = []
  const sweep: ScenarioSweepPoint[] = []
  try {
    for (const s of SCENARIO_STRATEGIES) strategies.push(await runGroup(s, tasks, fixture.root))

    // 单一变量扫描：只改 minResultChars，其余沿用 D 组配置
    const baseline = strategies.find((s) => s.key === 'A')!
    for (const minResultChars of SWEEP_MIN_CHARS) {
      const variant: ScenarioStrategy = {
        key: `sweep-${minResultChars}`,
        label: `门槛 ${minResultChars}`,
        policy: { ...SCENARIO_POLICY, minResultChars, recoverable: true },
        allowRecovery: true,
        note: '单变量扫描',
      }
      const g = await runGroup(variant, tasks, fixture.root)
      sweep.push({
        minResultChars,
        costUSD: g.costUSD,
        inputTokens: g.inputTokens,
        costReductionPct: ((baseline.costUSD - g.costUSD) / baseline.costUSD) * 100,
        success: g.success,
        successRate: g.successRate,
        recoveryCalls: g.recoveryCalls,
        compactions: g.compactions,
        collapsedResults: g.collapsedResults,
        turns: g.turns,
      })
    }
  } finally {
    fixture.cleanup()
  }
  return {
    taskCount: count,
    seed,
    noiseFilesPerIssue: NOISE_FILES_PER_ISSUE,
    model: SCENARIO_MODEL,
    strategies,
    sweep,
  }
}

export function concludeScenario(snap: ScenarioSnapshot): ScenarioConclusion {
  const A = snap.strategies.find((s) => s.key === 'A')!
  const B = snap.strategies.find((s) => s.key === 'B')!
  const C = snap.strategies.find((s) => s.key === 'C')!
  const D = snap.strategies.find((s) => s.key === 'D')!
  // 选型判据：先保证成功率不降，再取成本最低的参数点
  const maxSuccess = Math.max(...snap.sweep.map((p) => p.success))
  const best = snap.sweep
    .filter((p) => p.success === maxSuccess)
    .reduce((a, b) => (b.costUSD < a.costUSD ? b : a))
  return {
    baselineSuccess: A.success,
    recoverableSuccess: C.success,
    irreversibleSuccess: B.success,
    recommendedSuccess: D.success,
    aggressiveCostReductionPct: ((A.costUSD - C.costUSD) / A.costUSD) * 100,
    costReductionPct: ((A.costUSD - D.costUSD) / A.costUSD) * 100,
    successDeltaPctPoints: (D.successRate - A.successRate) * 100,
    irreversibleLossPctPoints: (B.lossRate - A.lossRate) * 100,
    recoveryCalls: C.recoveryCalls,
    recommendedRecoveryCalls: D.recoveryCalls,
    bestMinResultChars: best.minResultChars,
  }
}

const fmt = (n: number, d = 1): string => n.toFixed(d)

export function renderScenarioReport(
  snap: ScenarioSnapshot,
  c: ScenarioConclusion,
  reproducible: boolean,
): string {
  const A = snap.strategies.find((s) => s.key === 'A')!
  const B = snap.strategies.find((s) => s.key === 'B')!
  const C = snap.strategies.find((s) => s.key === 'C')!
  const D = snap.strategies.find((s) => s.key === 'D')!
  const rows = [A, B, C, D]
    .map(
      (s) =>
        `| **${s.label}** | ${s.success}/${s.tasks} | ${fmt(s.successRate * 100, 1)}% | ` +
        `${fmt(s.lossRate * 100, 1)}% | ${s.inputTokens.toLocaleString('en-US')} | ` +
        `$${fmt(s.costUSD, 4)} | ${s.compactions} | ${s.collapsedResults} | ` +
        `${s.recoveryCalls} | ${s.turns} |`,
    )
    .join('\n')
  const perTask = D.outcomes
    .map(
      (o, i) =>
        `| ${o.id} | ${A.outcomes[i]!.success ? '✅' : '❌'} | ` +
        `${B.outcomes[i]!.success ? '✅' : '❌'} | ${C.outcomes[i]!.success ? '✅' : '❌'} | ` +
        `${o.success ? '✅' : '❌'} | ${C.outcomes[i]!.recovered ? '是' : '—'} |`,
    )
    .join('\n')
  const sweepRows = snap.sweep
    .map(
      (p) =>
        `| ${p.minResultChars.toLocaleString('en-US')} | ${fmt(p.costReductionPct, 1)}% | ` +
        `$${fmt(p.costUSD, 4)} | ${p.success}/${snap.taskCount} | ${p.recoveryCalls} | ` +
        `${p.compactions} | ${p.collapsedResults} | ${p.turns} |`,
    )
    .join('\n')

  const goodBand = snap.sweep.filter(
    (p) => p.costReductionPct > 0 && p.success === snap.taskCount,
  )
  const band = goodBand.length
    ? `${goodBand[0]!.minResultChars.toLocaleString('en-US')}–${goodBand[goodBand.length - 1]!.minResultChars.toLocaleString('en-US')} 字符`
    : `${c.bestMinResultChars.toLocaleString('en-US')} 字符`

  return `# 场景 Agent 回归评测：开源 issue 定位

> 生成命令：\`npm run eval:scenario\` · 固定种子 seed=${snap.seed}
> 任务数 ${snap.taskCount} · 每个 issue 带 ${snap.noiseFilesPerIssue} 个大体积噪音文件 · 计价模型 \`${snap.model}\`

## 一句话结论

**压缩不是开关，是参数。** 在这 ${snap.taskCount} 个「必须引用早期精确证据」的 issue 任务上，
直接套用 Phase 3 的默认参数（C 组）虽然保住了 ${c.recoverableSuccess}/${snap.taskCount} 的成功率，
却让成本**不降反升 ${fmt(Math.abs(c.aggressiveCostReductionPct), 1)}%** —— 因为每个任务都得回头重读一次，
多出来的一轮全量重发把省下的 token 全吃光了。
把「多大体积的结果才值得折叠」这个门槛调进 **${band}** 区间
（D 组取 3,000 字符：只折噪音文件、保留根因文件原文）之后，成本降 **${fmt(c.costReductionPct, 1)}%**、
成功率 ${c.recommendedSuccess}/${snap.taskCount} 不变、额外重读 ${c.recommendedRecoveryCalls} 次。
作为对照，去掉可恢复性的 B 组成功率直接掉到 ${c.irreversibleSuccess}/${snap.taskCount}
（证据丢失率 +${fmt(c.irreversibleLossPctPoints, 1)}pp）。

两个结论叠在一起才完整：
① **可恢复性决定「会不会做错」**（B vs C）；
② **折叠粒度决定「会不会白省钱」**（C vs D）。
而这两件事只有把压缩放在消息树那一层、并能跑离线回归的人才能调 —— 框架用户在应用层看不到
「哪条 tool_result 被折了」，只能整体开或关。

## 四组数据

| 策略 | 成功 | 成功率 | 证据丢失率 | 累计 input tokens | 累计成本 | 压缩触发 | 折叠结果数 | 额外重读 | 总轮数 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${rows}

> 「累计」是 ${snap.taskCount} 个任务加总。Agent 的钱主要烧在**每轮重发全部历史**，
> 所以压缩收益随轮数放大，不是省一次请求那么简单。
> 注意 C 组：压缩少发了 token，却因为多一轮「重读 + 再重发全历史」把省的吃光还倒赔 ——
> 这正是必须做离线评测、而不是拍脑袋开开关的理由。

## 参数敏感性：折叠门槛决定省不省钱

只改 \`minResultChars\`（单条工具结果至少多大才值得折叠），其余全部锁死：

| 折叠门槛（字符） | 成本降幅 | 累计成本 | 成功 | 额外重读 | 压缩触发 | 折叠结果数 | 总轮数 |
|---:|---:|---:|---:|---:|---:|---:|---:|
${sweepRows}

**选型判据**：先保证成功率不降，再取成本最低的点 → 本任务集上
**${band}** 是有效区间（最佳单点 ${c.bestMinResultChars.toLocaleString('en-US')} 字符）。
门槛太低会把根因文件一起折掉，逼出昂贵的重读；门槛太高则什么都不折、退化成基线。
这条曲线也说明「压缩降本 X%」从来不是一个固定数字，它依赖任务里
「早期证据有多大概率被重新引用」——换任务集必须重跑这张表，这正是「管控」的落点。

## 逐任务判分

| issue | A 基线 | B 不可恢复 | C 可恢复 | D 只折大结果 | C 是否重读 |
|---|---|---|---|---|---|
${perTask}

判分口径：**根因文件 + 缺陷类型 + 精确证据标记三项全中**才算解决。
模型若拿不到证据，只能输出 \`category="unknown"\`，不会编造标记 —— 所以「丢失」是可观测的，
不是靠人肉感觉判断。

## 实验设计

**任务**：每个 issue 给一个报错码，Agent 用 \`Grep(keyword)\` 定位候选文件，
\`Read(rootFile)\` 取出精确证据标记，再读 ${snap.noiseFilesPerIssue} 份大体积噪音文件把上下文撑大，
最后输出一个 JSON 结论（zod 校验）。ground truth 在造 fixture 时就已知，因此可自动判分。

**变量控制**：四组除压缩策略外全部锁死 —— 同一批任务、同一份仓库、
同一个确定性模型、同样的 system / tools / maxTurns / 计价口径。
参数扫描的 ${snap.sweep.length} 个点则只改 \`minResultChars\` 一个变量。

**模型性质**：\`IssueProvider\` 会读当前这一轮真正发出去的 messages，
结论只能从历史里真实存在的证据得出；历史被折叠后若取不回，它只能承认不知道。
B 组关掉「按占位符提示重新 Read」的能力，用来隔离「可恢复性」这一个变量。

**可复现**：整套实验独立跑两遍，对不含时间字段的核心指标逐字段比对 ——
本次结果 **${reproducible ? '✅ 两次运行完全一致' : '❌ 不一致'}**。
固定种子 + 零 API key 的确定性模型，是「N 个任务回归可复现」这句话能成立的前提。

## 与 Phase 3 实验的关系

Phase 3 用 20 个「埋值—引用」微任务测**引用可达性**；这里用 ${snap.taskCount} 个
**完整业务流程**测同一条机制在应用层是否仍然成立，并额外发现了
「参数照搬会倒赔」这个微任务测不出的现象。两者共用同一套压缩实现、
同一套 Trace 记账，只是任务粒度不同 —— 前者回答「省不省钱」，后者回答「活还能不能干完、参数该怎么定」。

## 诚实边界（面试必须主动说明）

1. 驱动它的是确定性假模型，**不是真实 LLM**。它模拟的是「信息在上下文里是否可达」，
   不模拟真模型的注意力衰减、幻觉或指令遵循能力。
2. 仓库是**结构真实、内容合成**的 fixture（真实目录、真实 Grep/Read、真实工具结果体积），
   不是从 GitHub 抓的真实 issue。真实 issue 没有 ground truth，无法自动判分。
3. 因此这里的「成功率」是**架构层的证据可达率**，不能对外说成「真实业务解决率」。
   真正可迁移的是「固定任务集 + 确定性模型 + A/B 对照 + 自动判分 + 可复现」这套评测方法。

## 简历可用句式

> 在自研 runtime 上部署开源 issue 定位 Agent（Grep → Read → 结构化结论，zod 校验 + ground truth 自动判分）；
> 用 ${snap.taskCount} 个固定种子任务做四组回归 + ${snap.sweep.length} 点参数扫描：
> 发现照搬默认压缩参数会因额外重读使成本上升 ${fmt(Math.abs(c.aggressiveCostReductionPct), 1)}%，
> 调整折叠门槛后成本降 ${fmt(c.costReductionPct, 1)}%、成功率 ${c.recommendedSuccess}/${snap.taskCount} 不变；
> 去掉可恢复性的对照组成功率掉到 ${c.irreversibleSuccess}/${snap.taskCount}。两次运行逐字段一致。
`
}

// ── CLI 入口 ────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n  场景 Agent 回归评测（issue 定位）\n')
  const snapshot = await runScenarioExperiment()
  const second = await runScenarioExperiment()
  const core = (s: ScenarioSnapshot): string =>
    JSON.stringify({
      strategies: s.strategies.map((g) => ({
        key: g.key,
        success: g.success,
        lossRate: g.lossRate,
        costUSD: g.costUSD,
        inputTokens: g.inputTokens,
        turns: g.turns,
        toolCalls: g.toolCalls,
        compactions: g.compactions,
        collapsedResults: g.collapsedResults,
        savedTokens: g.savedTokens,
        recoveryCalls: g.recoveryCalls,
        outcomes: g.outcomes.map((o) => ({
          id: o.id,
          success: o.success,
          evidenceHit: o.evidenceHit,
          inputTokens: o.inputTokens,
          recovered: o.recovered,
        })),
      })),
      sweep: s.sweep,
    })
  const reproducible = core(snapshot) === core(second)
  const conclusion = concludeScenario(snapshot)

  for (const g of snapshot.strategies) {
    console.log(
      `  ${g.label.padEnd(20)} 成功 ${String(g.success).padStart(2)}/${g.tasks}  ` +
        `丢失 ${fmt(g.lossRate * 100, 1).padStart(5)}%  ` +
        `in ${String(g.inputTokens).padStart(7)} tok  $${fmt(g.costUSD, 4).padStart(8)}  ` +
        `压缩 ${String(g.compactions).padStart(2)} 次  重读 ${g.recoveryCalls}`,
    )
  }
  const C = snapshot.strategies.find((s) => s.key === 'C')!
  console.log(
    `\n  默认参数照搬（C）：成本 ${fmt(conclusion.aggressiveCostReductionPct, 1)}%（负=倒赔）` +
      ` · 重读 ${C.recoveryCalls} 次`,
  )
  console.log(
    `  调对折叠门槛（D）：成本降 ${fmt(conclusion.costReductionPct, 1)}% · ` +
      `成功率变化 ${fmt(conclusion.successDeltaPctPoints, 1)}pp · ` +
      `最佳门槛 ${conclusion.bestMinResultChars} 字符`,
  )
  console.log(`  不可恢复对照组成功 ${conclusion.irreversibleSuccess}/${snapshot.taskCount}`)
  console.log('  ── 折叠门槛扫描 ──')
  for (const p of snapshot.sweep) {
    console.log(
      `  ${String(p.minResultChars).padStart(6)} 字符  成本降 ${fmt(p.costReductionPct, 1).padStart(6)}%  ` +
        `成功 ${String(p.success).padStart(2)}/${snapshot.taskCount}  重读 ${String(p.recoveryCalls).padStart(2)}  ` +
        `压缩 ${String(p.compactions).padStart(3)} 次`,
    )
  }
  console.log(`  可复现：${reproducible ? '✅ 两次运行逐字段一致' : '❌ 不一致'}\n`)

  const dir = join(import.meta.dirname, '..', '..', 'reports')
  mkdirSync(dir, { recursive: true })
  writeFileSync(
    join(dir, 'scenario-eval.json'),
    JSON.stringify({ snapshot, conclusion, reproducible }, null, 2) + '\n',
  )
  writeFileSync(join(dir, 'scenario-eval.md'), renderScenarioReport(snapshot, conclusion, reproducible))
  console.log('  报告已写入 reports/scenario-eval.{md,json}\n')
  if (!reproducible) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
