/**
 * 压缩策略 A/B 对照实验（Phase 3 的产出：那组 X% / Y% 数字）
 *
 *   A 基线        —— 不压缩
 *   B 压缩·不可恢复 —— 大块结果换成一句「内容已移除」占位符（退化对照组）
 *   C 压缩·可恢复   —— 换成「原文未删除，可重新 Read(path=...) 取回」占位符
 *
 * 三组除了压缩策略，其余变量全部锁死：同一批 20 个任务、同一个确定性评测模型、
 * 同一套 token 估算、同一份 ReadTool、同样的 system / tools / maxTurns。
 *
 * 量三个数：
 *   ① 累计 input tokens → costUSD（Agent 的钱主要烧在每轮重发历史）
 *   ② 任务成功率 = 最终答案原样引用了埋值
 *   ③ 引用丢失率 = 1 - 成功率
 * 另记隐性成本：因信息被折叠而额外发生的「重新 Read」次数。
 *
 * 跑法：npm run eval:compaction
 * 产物：reports/compaction-experiment.md / .json（随仓库提交，面试官可直接看）
 *
 * ⚠️ 诚实边界见报告末节：这是确定性模拟模型上的**架构可达性实验**，
 *    不是真实 LLM 的业务成功率评测。别把数字包装成后者。
 */

import { mkdirSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { runAgent } from '../core/runAgent.js'
import { ToolRegistry } from '../core/tool.js'
import { ReadTool } from '../tools/ReadTool.js'
import { createUserMessage, type Message } from '../types/message.js'
import { summarizeTraces, type TraceSummary } from '../core/traceStore.js'
import { DEFAULT_COMPACTION_POLICY, type CompactionPolicy } from '../core/compaction.js'
import { EvalProvider, UNKNOWN_ANSWER } from './evalModel.js'
import {
  buildTasks,
  cleanup,
  materialize,
  TASK_COUNT,
  DEFAULT_SEED,
  NOISE_ROUNDS,
} from './evalTasks.js'

const MODEL = 'claude-sonnet-4' // 在 callModel.ts 的 PRICING 表里有明确单价：in $3 / out $15 per 1M
const SYSTEM = 'You are a coding agent. Use Read to inspect files. Answer with the exact value when asked.'

const SHARED_POLICY: Partial<CompactionPolicy> = {
  enabled: true,
  triggerTokens: 2_400,
  targetTokens: 1_200,
  protectRecentMessages: 4,
  minResultChars: 600,
  maxCollapsed: 24,
}

interface Strategy {
  key: string
  label: string
  policy: Partial<CompactionPolicy> | null
  allowRecovery: boolean
  note: string
}

const STRATEGIES: Strategy[] = [
  {
    key: 'A',
    label: 'A 基线（不压缩）',
    policy: null,
    allowRecovery: true,
    note: '原样重发全部历史，信息必然可达，但每轮都烧钱',
  },
  {
    key: 'B',
    label: 'B 压缩·不可恢复',
    policy: { ...SHARED_POLICY, recoverable: false },
    allowRecovery: false,
    note: '占位符只说「已移除」，信息真的丢了 —— 用来证明可恢复设计的价值',
  },
  {
    key: 'C',
    label: 'C 压缩·可恢复',
    policy: { ...SHARED_POLICY, recoverable: true },
    allowRecovery: true,
    note: '占位符写明原路径，模型按需重新 Read 取回',
  },
]

/**
 * 参数敏感性扫描：两个维度，各只改一个参数，其余全部锁死。
 *
 * 第一轮只扫 [1600, 2400, 4000, 8000] 时四个点结果完全一样 —— 因为
 * 单条工具结果就有约 2.7k token，压缩后的稳态上下文也有约 6k，
 * 这几个阈值下「每轮都触发、且总是把保护窗口以外的全压掉」，稳态相同。
 * 平线不是曲线，所以把阈值拉到覆盖「从不触发」的区间，
 * 并补扫真正的主导参数：**末尾保护窗口**（它决定「多少历史不准动」）。
 */
export const SWEEP_THRESHOLDS = [1_600, 6_000, 12_000, 20_000, 40_000] as const
export const SWEEP_PROTECT = [2, 4, 6, 8, 12, 16, 24] as const

export interface SweepPoint {
  dimension: 'threshold' | 'protect'
  label: string
  triggerTokens: number
  targetTokens: number
  protectRecentMessages: number
  costUSD: number
  inputTokens: number
  costReductionPct: number
  success: number
  lossRate: number
  compactions: number
  savedTokens: number
  recoveryCalls: number
  turns: number
}

interface TaskOutcome {
  id: string
  success: boolean
  inputTokens: number
  outputTokens: number
  costUSD: number
  turns: number
  toolCalls: number
  recovered: boolean
  compactions: number
  collapsedResults: number
  savedTokens: number
}

interface StrategyResult {
  key: string
  label: string
  note: string
  tasks: number
  success: number
  lossRate: number
  inputTokens: number
  outputTokens: number
  costUSD: number
  turns: number
  toolCalls: number
  compactions: number
  collapsedResults: number
  savedTokens: number
  recoveryCalls: number
  outcomes: TaskOutcome[]
}

/** 不含任何时间字段 —— 两次运行直接比对这份结构就能证明可复现 */
export interface ExperimentSnapshot {
  taskCount: number
  seed: number
  noiseRounds: number
  model: string
  policy: Partial<CompactionPolicy> | null
  strategies: StrategyResult[]
  sweep: SweepPoint[]
}

async function runStrategy(
  s: Strategy,
  fixtureTasks: ReturnType<typeof buildTasks>,
  root: string,
): Promise<StrategyResult> {
  const outcomes: TaskOutcome[] = []

  for (const task of fixtureTasks) {
    const provider = new EvalProvider({ task, allowRecovery: s.allowRecovery })
    const messages: Message[] = [createUserMessage(task.question)]
    const tools = new ToolRegistry().register(ReadTool)

    const result = await runAgent({
      provider,
      model: MODEL,
      system: SYSTEM,
      tools,
      messages,
      cwd: root,
      compaction: s.policy,
      maxTurns: 20,
    })

    const t: TraceSummary = summarizeTraces(result.traces)
    // finalText 必须原样包含埋值，且不能是 UNKNOWN —— 双重判定防误报
    const success =
      result.finalText.includes(task.secret) && !result.finalText.includes(UNKNOWN_ANSWER)

    outcomes.push({
      id: task.id,
      success,
      inputTokens: t.inputTokens,
      outputTokens: t.outputTokens,
      costUSD: t.costUSD,
      turns: result.turns,
      toolCalls: t.toolCalls,
      recovered: provider.recoveries > 0,
      compactions: t.compactions,
      collapsedResults: t.collapsedResults,
      savedTokens: t.compactionSavedTokens,
    })
  }

  const sum = (f: (o: TaskOutcome) => number): number => outcomes.reduce((a, o) => a + f(o), 0)
  const success = outcomes.filter((o) => o.success).length

  return {
    key: s.key,
    label: s.label,
    note: s.note,
    tasks: outcomes.length,
    success,
    lossRate: (outcomes.length - success) / outcomes.length,
    inputTokens: sum((o) => o.inputTokens),
    outputTokens: sum((o) => o.outputTokens),
    costUSD: sum((o) => o.costUSD),
    turns: sum((o) => o.turns),
    toolCalls: sum((o) => o.toolCalls),
    compactions: sum((o) => o.compactions),
    collapsedResults: sum((o) => o.collapsedResults),
    savedTokens: sum((o) => o.savedTokens),
    recoveryCalls: outcomes.filter((o) => o.recovered).length,
    outcomes,
  }
}

export async function runExperiment(
  count = TASK_COUNT,
  seed = DEFAULT_SEED,
): Promise<ExperimentSnapshot> {
  const tasks = buildTasks(count, seed)
  const fixture = materialize(tasks, seed)
  const strategies: StrategyResult[] = []
  try {
    for (const s of STRATEGIES) strategies.push(await runStrategy(s, tasks, fixture.root))

    const baseline = strategies.find((s) => s.key === 'A')!
    const sweep: SweepPoint[] = []

    const addPoint = async (
      dimension: SweepPoint['dimension'],
      label: string,
      policy: Partial<CompactionPolicy>,
    ): Promise<void> => {
      const variant: Strategy = {
        key: `sweep-${dimension}-${sweep.length}`,
        label,
        policy: { ...policy, recoverable: true },
        allowRecovery: true,
        note: '参数敏感性扫描',
      }
      const r = await runStrategy(variant, tasks, fixture.root)
      sweep.push({
        dimension,
        label,
        triggerTokens: policy.triggerTokens ?? DEFAULT_COMPACTION_POLICY.triggerTokens,
        targetTokens: policy.targetTokens ?? DEFAULT_COMPACTION_POLICY.targetTokens,
        protectRecentMessages:
          policy.protectRecentMessages ?? DEFAULT_COMPACTION_POLICY.protectRecentMessages,
        costUSD: r.costUSD,
        inputTokens: r.inputTokens,
        costReductionPct: ((baseline.costUSD - r.costUSD) / baseline.costUSD) * 100,
        success: r.success,
        lossRate: r.lossRate,
        compactions: r.compactions,
        savedTokens: r.savedTokens,
        recoveryCalls: r.recoveryCalls,
        turns: r.turns,
      })
    }

    // 维度一：触发阈值（目标预算恒为阈值一半）
    for (const triggerTokens of SWEEP_THRESHOLDS) {
      await addPoint('threshold', `阈值 ${triggerTokens}`, {
        ...SHARED_POLICY,
        triggerTokens,
        targetTokens: Math.floor(triggerTokens / 2),
      })
    }
    // 维度二：末尾保护窗口（固定阈值）—— 它决定「多少历史绝对不准动」
    for (const protectRecentMessages of SWEEP_PROTECT) {
      await addPoint('protect', `保护末尾 ${protectRecentMessages} 条`, {
        ...SHARED_POLICY,
        protectRecentMessages,
      })
    }

    return {
      taskCount: count,
      seed,
      noiseRounds: NOISE_ROUNDS,
      model: MODEL,
      policy: SHARED_POLICY,
      strategies,
      sweep,
    }
  } finally {
    cleanup(fixture)
  }
}

// ── 结论计算 ────────────────────────────────────────────────

export interface Conclusion {
  costReductionPct: number
  tokensReductionPct: number
  lossPctPoints: number
  bLossPctPoints: number
  cLossPctPoints: number
  savedTokens: number
  recoveryCalls: number
  extraTurns: number
}

export function conclude(snap: ExperimentSnapshot): Conclusion {
  const A = snap.strategies.find((s) => s.key === 'A')!
  const B = snap.strategies.find((s) => s.key === 'B')!
  const C = snap.strategies.find((s) => s.key === 'C')!
  const pct = (base: number, now: number): number => (base === 0 ? 0 : ((base - now) / base) * 100)
  return {
    costReductionPct: pct(A.costUSD, C.costUSD),
    tokensReductionPct: pct(A.inputTokens, C.inputTokens),
    lossPctPoints: (C.lossRate - A.lossRate) * 100,
    bLossPctPoints: (B.lossRate - A.lossRate) * 100,
    cLossPctPoints: (C.lossRate - A.lossRate) * 100,
    savedTokens: C.savedTokens,
    recoveryCalls: C.recoveryCalls,
    extraTurns: C.turns - A.turns,
  }
}

// ── 报告 ────────────────────────────────────────────────────

function fmt(n: number, digits = 2): string {
  return n.toFixed(digits)
}

export function renderReport(snap: ExperimentSnapshot, c: Conclusion, reproducible: boolean): string {
  const A = snap.strategies.find((s) => s.key === 'A')!
  const B = snap.strategies.find((s) => s.key === 'B')!
  const C = snap.strategies.find((s) => s.key === 'C')!
  const perSuccess = (s: StrategyResult): string =>
    s.success === 0 ? '∞（无成功任务）' : `$${fmt(s.costUSD / s.success, 4)}`
  const rows = [A, B, C]
    .map(
      (s) =>
        `| **${s.label}** | ${s.success}/${s.tasks} | ${fmt(s.lossRate * 100, 1)}% | ` +
        `${s.inputTokens.toLocaleString('en-US')} | $${fmt(s.costUSD, 4)} | ${perSuccess(s)} | ` +
        `${s.compactions} | ${s.collapsedResults} | ${s.recoveryCalls} | ${s.turns} |`,
    )
    .join('\n')
  const sweepTable = (dim: SweepPoint['dimension']): string =>
    snap.sweep
      .filter((p) => p.dimension === dim)
      .map(
        (p) =>
          `| ${p.label} | ${fmt(p.costReductionPct, 1)}% | $${fmt(p.costUSD, 4)} | ` +
          `${p.compactions} | ${p.recoveryCalls} | ${p.turns} | ${fmt(p.lossRate * 100, 1)}% |`,
      )
      .join('\n')
  const thresholdRows = sweepTable('threshold')
  const protectRows = sweepTable('protect')
  const spread = (dim: SweepPoint['dimension']): number => {
    const v = snap.sweep.filter((p) => p.dimension === dim).map((p) => p.costReductionPct)
    return v.length === 0 ? 0 : Math.max(...v) - Math.min(...v)
  }
  const thresholdSpread = spread('threshold')
  const protectSpread = spread('protect')
  const dominant = protectSpread > thresholdSpread ? '末尾保护窗口' : '触发阈值'
  const lossyPoints = snap.sweep.filter((p) => p.lossRate > 0).length
  const negativePoints = snap.sweep.filter((p) => p.costReductionPct < -0.05)
  const inactivePoints = snap.sweep.filter((p) => p.compactions === 0).length
  const bestProtect = snap.sweep
    .filter((p) => p.dimension === 'protect')
    .reduce((a, b) => (b.costReductionPct > a.costReductionPct ? b : a))
  const worstPoint = snap.sweep.reduce((a, b) => (b.costReductionPct < a.costReductionPct ? b : a))

  return `# 上下文压缩 A/B 对照实验

> 自动生成，勿手改。复现：\`npm run eval:compaction\`
> 任务集：${snap.taskCount} 个「埋值 → 隔 ${snap.noiseRounds} 轮噪音 → 引用」回归任务，seed=${snap.seed}
> 计价模型：\`${snap.model}\`（输入 $3 / 输出 $15 per 1M tokens）
> 参数扫描：${snap.sweep.length} 个额外参数点（触发阈值 × 保护窗口）

## 一句话结论

**可恢复压缩让累计输入成本下降 ${fmt(c.costReductionPct, 1)}%（input tokens 降 ${fmt(c.tokensReductionPct, 1)}%），
引用丢失率保持 ${fmt(C.lossRate * 100, 1)}%（相对基线 +${fmt(c.lossPctPoints, 1)}pp）；代价是 ${c.recoveryCalls} 次额外重读、共多 ${c.extraTurns} 轮。**
作为对照，去掉「可恢复」这一条设计后，引用丢失率飙升 **+${fmt(c.bLossPctPoints, 1)} 个百分点** ——
B 组虽然单价最便宜，却**一个任务都没做对**。这说明压缩策略里真正值钱的不是折叠动作本身，而是**可恢复性**：
省钱会不会让模型失忆，取决于占位符有没有留下一条取回原文的路。

## 三组数据

| 策略 | 成功 | 引用丢失率 | 累计 input tokens | 累计成本 | 每成功任务成本 | 压缩触发 | 折叠结果数 | 额外重读 | 总轮数 |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
${rows}

> 「累计」是 ${snap.taskCount} 个任务加总。Agent 的成本主要来自**每一轮重新发送全部历史**，
> 所以压缩的收益会随轮数放大，而不是省一次请求那么简单。
> 「每成功任务成本」是这张表里最容易被忽略的一列：只看单价，B 组最便宜；算上有效性，它最贵。

### 为什么 C 组能做到零丢失（机制说明，不是运气）

模型在最后一轮发现精确值不在上下文里，但看到了折叠占位符里的原路径，于是再调一次 \`Read\` 取回。
这次重读的结果落在**末尾 ${snap.policy?.protectRecentMessages} 条消息的保护窗口内**，不会被下一轮压缩二次折叠，
所以信息必然可达。零丢失是这个设计的结构性结果；它的代价被诚实地记在「额外重读 / 总轮数」两列上。

## 参数敏感性：真正的权衡曲线

两个维度，各只改一个参数，其余全部锁死。指标口径与主表一致。

### 维度一 · 触发阈值（目标预算恒为阈值一半）

| 阈值 / 预算 | 成本降幅 | 累计成本 | 压缩触发 | 额外重读 | 总轮数 | 引用丢失率 |
|---|---:|---:|---:|---:|---:|---:|
${thresholdRows}

### 维度二 · 末尾保护窗口（固定阈值 ${snap.policy?.triggerTokens}）

| 保护窗口 | 成本降幅 | 累计成本 | 压缩触发 | 额外重读 | 总轮数 | 引用丢失率 |
|---|---:|---:|---:|---:|---:|---:|
${protectRows}

**观察到的两件事**：

1. 成本降幅的跨度：阈值维度 ${fmt(thresholdSpread, 1)}pp、保护窗口维度 ${fmt(protectSpread, 1)}pp ——
   **${dominant}才是这套实现里的主导参数**。预实验只扫了 1600/2400/4000/8000 四个阈值，
   结果是一条平线：单条工具结果就约 2.7k token，压缩后的稳态上下文也有约 6k，
   这几个阈值下每轮都触发、且总是把保护窗口以外的全压掉，稳态完全相同。
   所以阈值必须扫到「从不触发」的区间才看得到拐点，而保护窗口直接决定「多少历史绝对不准动」。
2. 扫描里出现引用丢失的参数点：${lossyPoints} 个${lossyPoints > 0 ? '（说明参数选错确实会伤到可达性，不是只有「全好」和「全坏」两种结局）' : '（本组参数下可恢复性把丢失都兜住了）'}。

**这就是「管控」两个字的落点**：触发时机、预算目标、保护窗口都必须是可配置、可量化的参数，
而不是硬编码的魔法数字；每改一个参数，都要能重新跑出上面这张表再决定取值。

## 参数选型：扫描给出的三条硬结论

1. **主导参数是保护窗口，不是触发阈值。** 阈值维度降幅跨度 ${fmt(thresholdSpread, 1)}pp，
   保护窗口维度 ${fmt(protectSpread, 1)}pp。原因很直白：阈值只决定「哪一轮开始动手」，
   保护窗口决定「每一轮到底能压掉多少」—— 后者直接乘在每一轮的收益上。
2. **参数选错会比不压缩更贵。** ${negativePoints.length} 个参数点的成本降幅为负，
   最差的是「${worstPoint.label}」：**${fmt(worstPoint.costReductionPct, 1)}%**（即多花钱）。
   压缩照常触发、模型照样看到占位符回去重读（多出轮次），但保护窗口太大几乎没省下输入 token，
   净效果变成亏钱。这是整套实验里最反直觉、也最该写进设计文档的一条。
3. **阈值是开关，不是灵敏度旋钮。** 小阈值下每轮都触发且稳态相同（这就是第一轮扫描出现平线的原因），
   中等阈值把降幅砍到一半，共 ${inactivePoints} 个参数点（含阈值 ≥20000 与保护窗口 ≥12）触发次数为 0、完全退化成基线。

主实验默认取 \`trigger=${snap.policy?.triggerTokens} / target=${snap.policy?.targetTokens} / protect=${snap.policy?.protectRecentMessages}\`
（降 ${fmt(c.costReductionPct, 1)}%），是**保守折中，不是最优**：扫描里「${bestProtect.label}」在这套任务上
能到 ${fmt(bestProtect.costReductionPct, 1)}% 且零丢失，但它只保护最后一轮交互，对真实长会话风险更大。
正确的生产用法不是拍脑袋定一个值，而是：换一批代表性任务 → 重跑 \`npm run eval:compaction\` → 按新曲线定参数。

## 实验设计

**考卷**：每个任务先把一个精确值（如 \`VLT-3A9F-21\`）埋进 \`target\` 文件，中间再读 ${snap.noiseRounds} 个大文件
把上下文撑爆、把埋值结果挤到历史早期，最后要求原样引用这个值。不这样设计，就测不出「引用丢失」。

**三组**（除压缩策略外全部锁死：同一批任务、同一个确定性评测模型、同一套 token 估算、同一份 ReadTool）：

| 组 | 做法 |
|---|---|
| A | 完全不压缩（基线） |
| B | 大块 \`tool_result\` → 「内容已移除，不可恢复」占位符 |
| C | 大块 \`tool_result\` → 「原文未删除，可重新 \`Read(path=...)\` 取回」占位符 |

**压缩策略**：触发阈值 ${snap.policy?.triggerTokens} tokens、目标预算 ${snap.policy?.targetTokens} tokens、
末尾 ${snap.policy?.protectRecentMessages} 条消息不动、单条结果超过 ${snap.policy?.minResultChars} 字符才折叠。
每条消息压完做五项自检（配对 / 首条 / 最近保护 / uuid 链 / 确有节省），任意一项不过就整套回滚。

**参数扫描**：另跑 ${snap.sweep.length} 个参数点（${SWEEP_THRESHOLDS.length} 个触发阈值 + ${SWEEP_PROTECT.length} 个保护窗口），
每点仍是同一批 ${snap.taskCount} 个任务、同一套评测模型，只改一个参数。它把「压缩好不好」这个问题
升级成「在什么参数下好、在什么参数下反而更差」。

**指标定义**：
- 引用丢失 = 最终答案没有原样给出埋值（含 \`UNKNOWN\` 与编造）
- 成本 = \`estimateCostUSD(model, usage)\` 按每轮真实 \`input_tokens\` 累加
- 额外重读 = 因为看到折叠占位符而再次调用 Read 的任务数

**可复现性**：${reproducible ? '✅ 两次独立运行的核心指标逐字段一致' : '❌ 两次运行结果不一致（需排查）'}。
评测模型零 API key、零 \`Math.random\`、任务集由固定种子 LCG 生成，因此不存在真 API 实验常见的漂移。

## 诚实边界（面试请主动讲）

1. **这不是真 LLM**。评测模型是确定性的，它模拟的是「信息在上下文里是否可达」这一条机制，
   不模拟真实模型的注意力衰减、幻觉或指令遵循能力。数字应表述为**架构层的可达性/成本指标**，
   不是真实业务任务成功率。
2. **token 是估算**，不是厂商计数。中文按 1 字 1 token、其余按 4 字符 1 token；
   三组用同一套估算，对照关系成立，绝对值不等于账单。
3. **数字是这套参数下的结果**。换任务集、阈值、保护窗口，X% 和 Y% 都会变 —— 
   真正可迁移的是这套「固定任务集 + 确定性模型 + A/B/C 三组 + 可复现验证」的实验方法。

## 简历可用句式

> 自研 Agent runtime 上实现可恢复上下文压缩（大块工具结果 → 带原路径的可恢复占位符，
> 压后五项自检失败即回滚，触发阈值/预算/保护窗口可配）；用 ${snap.taskCount} 个「埋值—引用」确定性回归任务做 A/B/C 对照 +
> 两维度参数扫描（${snap.sweep.length} 个参数点）：累计输入成本降 ${fmt(c.costReductionPct, 1)}%，引用丢失率 +${fmt(c.lossPctPoints, 1)}pp，
> 代价是 ${c.recoveryCalls} 次额外重读；去掉可恢复性的对照组丢失率 +${fmt(c.bLossPctPoints, 1)}pp。实验两次运行逐字段一致。

⚠️ 面试时**必须**补上上面第 1 条边界。把它说成「真实模型评测」会被追问到穿帮；
主动说明「这是架构可达性实验」，反而体现你分得清实验测的是什么。
`
}

// ── CLI 入口 ────────────────────────────────────────────────

async function main(): Promise<void> {
  console.log('\n  上下文压缩 A/B 对照实验\n')
  const snapshot = await runExperiment()
  const conclusion = conclude(snapshot)

  // 独立再跑一遍，逐字段比对核心指标（不含任何时间/随机字段）
  const second = await runExperiment()
  const core = (s: ExperimentSnapshot): string =>
    JSON.stringify({
      strategies: s.strategies.map((r) => ({
        key: r.key,
        success: r.success,
        lossRate: r.lossRate,
        inputTokens: r.inputTokens,
        costUSD: r.costUSD,
        turns: r.turns,
        toolCalls: r.toolCalls,
        compactions: r.compactions,
        collapsedResults: r.collapsedResults,
        savedTokens: r.savedTokens,
        recoveryCalls: r.recoveryCalls,
        outcomes: r.outcomes.map((o) => ({ id: o.id, success: o.success, inputTokens: o.inputTokens })),
      })),
      sweep: s.sweep,
    })
  const reproducible = core(snapshot) === core(second)
  console.log('  ── 三组结果 ──')
  for (const s of snapshot.strategies) {
    console.log(
      `  ${s.label.padEnd(20)} 成功 ${String(s.success).padStart(2)}/${s.tasks}  ` +
        `丢失率 ${fmt(s.lossRate * 100, 1).padStart(5)}%  ` +
        `in ${String(s.inputTokens).padStart(7)} tok  ` +
        `$${fmt(s.costUSD, 4).padStart(8)}  ` +
        `压缩 ${String(s.compactions).padStart(2)} 次  重读 ${s.recoveryCalls}`,
    )
  }
  console.log(
    `\n  成本降 ${fmt(conclusion.costReductionPct, 1)}% · ` +
      `引用丢失 +${fmt(conclusion.lossPctPoints, 1)}pp · ` +
      `不可恢复对照组 +${fmt(conclusion.bLossPctPoints, 1)}pp`,
  )
  for (const dim of ['threshold', 'protect'] as const) {
    console.log(`  ── 参数敏感性（${dim === 'threshold' ? '触发阈值' : '保护窗口'}）──`)
    for (const p of snapshot.sweep.filter((x) => x.dimension === dim)) {
      console.log(
        `  ${p.label.padEnd(20)} 成本降 ${fmt(p.costReductionPct, 1).padStart(5)}%  ` +
          `重读 ${String(p.recoveryCalls).padStart(2)}  压缩 ${String(p.compactions).padStart(3)} 次  ` +
          `丢失 ${fmt(p.lossRate * 100, 0)}%`,
      )
    }
  }
  console.log(`  可复现：${reproducible ? '✅ 两次运行逐字段一致' : '❌ 不一致'}\n`)

  const dir = join(import.meta.dirname, '..', '..', 'reports')
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'compaction-experiment.json'), JSON.stringify({ snapshot, conclusion, reproducible }, null, 2) + '\n')
  writeFileSync(join(dir, 'compaction-experiment.md'), renderReport(snapshot, conclusion, reproducible))
  console.log('  报告已写入 reports/compaction-experiment.{md,json}\n')

  if (!reproducible) process.exitCode = 1
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}
