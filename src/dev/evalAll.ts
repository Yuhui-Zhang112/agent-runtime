/**
 * 统一 Eval 套件（Phase 5）
 *
 * 职责不是再跑一遍实验，而是把两套已生成的实验报告**汇总 + 校验 + 对齐口径**：
 *   - 校验两个套件都真实跑过、且两次运行逐字段一致（reproducible === true）
 *   - 抽出给看板 / 简历用的关键数字，落成 reports/eval-summary.json
 *   - 任一校验不过就 exit 1 —— CI 里它就是「回归门禁」，不是装饰性脚本
 *
 * 跑法：npm run eval:all（= eval:compaction + eval:scenario + 本文件）
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const REPORTS_DIR = join(import.meta.dirname, '..', '..', 'reports')

interface JsonReport {
  reproducible?: boolean
  conclusion?: Record<string, unknown>
  snapshot?: Record<string, unknown>
}

function load(name: string): JsonReport {
  const path = join(REPORTS_DIR, name)
  let parsed: JsonReport
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8')) as JsonReport
  } catch (err) {
    throw new Error(`读取 ${name} 失败（先跑 npm run eval:all 里的实验）：${String(err)}`)
  }
  if (parsed.reproducible !== true) {
    throw new Error(`${name} 的可复现校验未通过（reproducible=${String(parsed.reproducible)}）`)
  }
  if (!parsed.snapshot || !parsed.conclusion) {
    throw new Error(`${name} 缺少 snapshot / conclusion 字段`)
  }
  return parsed
}

function strategiesOf(snap: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = snap.strategies
  if (!Array.isArray(raw)) throw new Error('snapshot.strategies 不是数组')
  return raw.map((s) => {
    const g = s as Record<string, unknown>
    return {
      key: g.key,
      label: g.label,
      tasks: g.tasks,
      success: g.success,
      successRate: g.successRate ?? null,
      lossRate: g.lossRate,
      costUSD: g.costUSD,
      inputTokens: g.inputTokens,
      compactions: g.compactions,
      collapsedResults: g.collapsedResults,
      recoveryCalls: g.recoveryCalls,
      turns: g.turns,
    }
  })
}

function sweepOf(snap: Record<string, unknown>): Array<Record<string, unknown>> {
  const raw = snap.sweep
  return Array.isArray(raw) ? (raw as Array<Record<string, unknown>>) : []
}

export function buildEvalSummary(): Record<string, unknown> {
  const compaction = load('compaction-experiment.json')
  const scenario = load('scenario-eval.json')
  const cs = compaction.snapshot!
  const cc = compaction.conclusion!
  const ss = scenario.snapshot!
  const sc = scenario.conclusion!

  const suites = [
    {
      key: 'compaction',
      name: '上下文压缩 A/B 评测',
      command: 'npm run eval:compaction',
      report: 'reports/compaction-experiment.md',
      taskCount: cs.taskCount,
      seed: cs.seed,
      reproducible: true,
      strategies: strategiesOf(cs),
      sweep: sweepOf(cs),
      headline: {
        costReductionPct: cc.costReductionPct,
        lossPctPoints: cc.lossPctPoints,
        irreversibleLossPctPoints: cc.bLossPctPoints,
        recoveryCalls: cc.recoveryCalls,
      },
    },
    {
      key: 'scenario',
      name: 'issue 定位场景回归',
      command: 'npm run eval:scenario',
      report: 'reports/scenario-eval.md',
      taskCount: ss.taskCount,
      seed: ss.seed,
      reproducible: true,
      strategies: strategiesOf(ss),
      sweep: sweepOf(ss),
      headline: {
        costReductionPct: sc.costReductionPct,
        aggressiveCostReductionPct: sc.aggressiveCostReductionPct,
        recommendedSuccess: sc.recommendedSuccess,
        irreversibleSuccess: sc.irreversibleSuccess,
        irreversibleLossPctPoints: sc.irreversibleLossPctPoints,
        bestMinResultChars: sc.bestMinResultChars,
      },
    },
  ]

  return {
    generatedBy: 'npm run eval:all',
    // 故意不写时间戳：这份产物本身也该是确定性的，每次跑完 git diff 为空
    suites,
    highlights: [
      `压缩实验：累计输入成本降 ${Number(cc.costReductionPct).toFixed(1)}%，引用丢失 +${Number(cc.lossPctPoints).toFixed(1)}pp`,
      `场景实验：调对折叠门槛后成本降 ${Number(sc.costReductionPct).toFixed(1)}%，成功率 ${String(sc.recommendedSuccess)}/${String(ss.taskCount)} 不变`,
      `反例：照搬默认参数成本上升 ${Math.abs(Number(sc.aggressiveCostReductionPct)).toFixed(1)}%；不可恢复对照组成功 ${String(sc.irreversibleSuccess)}/${String(ss.taskCount)}`,
      '全部实验零 API key、固定种子、两次运行逐字段一致',
    ],
    // 看板会把这几条原样显示，避免对外把架构实验说成真实模型评测
    boundary: [
      '驱动实验的是确定性假模型，不是真实 LLM；测的是「信息在上下文里是否可达」。',
      '任务集与仓库是固定种子合成的 fixture，成功率是架构层证据可达率，不是真实业务解决率。',
      '可迁移的是「固定任务集 + A/B 对照 + 自动判分 + 可复现验证」这套评测方法。',
    ],
  }
}

async function main(): Promise<void> {
  console.log('\n  统一 Eval 套件：汇总 + 可复现门禁\n')
  const summary = buildEvalSummary()
  const suites = summary.suites as Array<{ name: string; taskCount: unknown; strategies: unknown[] }>
  for (const s of suites) {
    console.log(`  ✅ ${s.name.padEnd(24)} ${String(s.taskCount).padStart(2)} 个任务 · ${s.strategies.length} 组策略 · 可复现`)
  }
  for (const h of summary.highlights as string[]) console.log(`  · ${h}`)

  mkdirSync(REPORTS_DIR, { recursive: true })
  writeFileSync(
    join(REPORTS_DIR, 'eval-summary.json'),
    JSON.stringify(summary, null, 2) + '\n',
  )
  console.log('\n  已写入 reports/eval-summary.json（看板数据源）\n')
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(`  ❌ ${err instanceof Error ? err.message : String(err)}\n`)
    process.exit(1)
  })
}
