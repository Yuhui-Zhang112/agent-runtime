/**
 * 统一 Eval 门禁冒烟测试（Phase 5 · 零 API key、毫秒级）
 *
 * 它不重跑实验（那是 eval:all 的事，要几分钟），而是守住「产物可信」这件事：
 *   - 两份实验报告都必须带 reproducible === true
 *   - buildEvalSummary() 的输出必须是确定性的（连跑两次逐字节一致）
 *   - 已提交的 reports/eval-summary.json 必须等于当前构建结果（防止代码改了、产物没更新）
 *   - 关键结论方向不许倒挂；诚实边界不许被删掉
 *
 * CI 里 eval:all 之后跑它：既能拦住"报告是手改的"，也能拦住"看板读的是旧数字"。
 */

import { readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

import { buildEvalSummary } from './evalAll.js'

type Check = [string, boolean, string?]
const checks: Check[] = []
const REPORTS_DIR = join(import.meta.dirname, '..', '..', 'reports')

function read(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(REPORTS_DIR, name), 'utf8')) as Record<string, unknown>
}

function main(): void {
  const compaction = read('compaction-experiment.json')
  const scenario = read('scenario-eval.json')

  checks.push([
    'K 压缩实验声明可复现',
    compaction.reproducible === true,
    String(compaction.reproducible),
  ])
  checks.push([
    'K 场景实验声明可复现',
    scenario.reproducible === true,
    String(scenario.reproducible),
  ])

  const first = JSON.stringify(buildEvalSummary(), null, 2) + '\n'
  const second = JSON.stringify(buildEvalSummary(), null, 2) + '\n'
  checks.push(['K 汇总结果确定性（两次逐字节一致）', first === second, `${first.length} 字节`])

  const summary = JSON.parse(first) as {
    suites: Array<Record<string, unknown>>
    highlights: string[]
    boundary: string[]
    generatedAt?: string
  }
  const keys = summary.suites.map((s) => s.key)
  checks.push([
    'K 两个套件都进汇总',
    keys.length === 2 && keys.includes('compaction') && keys.includes('scenario'),
    keys.join(' + '),
  ])
  checks.push([
    'K 每个套件都有策略组与参数扫描',
    summary.suites.every(
      (s) => (s.strategies as unknown[]).length >= 3 && (s.sweep as unknown[]).length >= 3,
    ),
    summary.suites
      .map((s) => `${(s.strategies as unknown[]).length}组/${(s.sweep as unknown[]).length}点`)
      .join(' · '),
  ])
  checks.push([
    'K 产物不含时间戳（可复现）',
    summary.generatedAt === undefined && !first.includes('generatedAt'),
    '无 generatedAt',
  ])
  checks.push(['K 诚实边界未被删减', summary.boundary.length >= 3, `${summary.boundary.length} 条`])
  checks.push(['K 简历口径随产物一起生成', summary.highlights.length >= 4, `${summary.highlights.length} 条`])

  const cc = (summary.suites.find((s) => s.key === 'compaction')!.headline ?? {}) as Record<string, number>
  const sc = (summary.suites.find((s) => s.key === 'scenario')!.headline ?? {}) as Record<string, number>
  const taskCount = Number(summary.suites.find((s) => s.key === 'scenario')!.taskCount)
  checks.push([
    'K 压缩实验结论方向正确',
    Number(cc.costReductionPct) > 0 && Number(cc.lossPctPoints) === 0 && Number(cc.irreversibleLossPctPoints) > 0,
    `省 ${Number(cc.costReductionPct).toFixed(1)}% / 丢失 +${Number(cc.lossPctPoints).toFixed(1)}pp`,
  ])
  checks.push([
    'K 场景实验：调参后省钱且不掉成功率',
    Number(sc.costReductionPct) > 0 && Number(sc.recommendedSuccess) === taskCount && Number(sc.irreversibleSuccess) === 0,
    `省 ${Number(sc.costReductionPct).toFixed(1)}% / ${sc.recommendedSuccess}/${taskCount}`,
  ])
  checks.push([
    'K 反例仍在（参数照搬会倒赔）',
    Number(sc.aggressiveCostReductionPct) < 0 && Number(sc.bestMinResultChars) > 0,
    `${Number(sc.aggressiveCostReductionPct).toFixed(1)}% / 门槛 ${sc.bestMinResultChars}`,
  ])

  const committed = join(REPORTS_DIR, 'eval-summary.json')
  const onDisk = existsSync(committed) ? readFileSync(committed, 'utf8') : null
  checks.push([
    'K 已提交产物与当前报告一致',
    onDisk === first,
    onDisk === null ? '缺少 reports/eval-summary.json' : onDisk === first ? '一致' : '陈旧，需重跑 npm run eval:all',
  ])
  checks.push([
    'K 两份人读报告都已生成',
    existsSync(join(REPORTS_DIR, 'compaction-experiment.md')) &&
      existsSync(join(REPORTS_DIR, 'scenario-eval.md')),
    'md × 2',
  ])

  console.log('\n统一 Eval 门禁（零 API key）\n')
  let pass = 0
  for (const [name, ok, note] of checks) {
    if (ok) pass += 1
    console.log(`${ok ? '  ✓' : '  ✗'} ${name.padEnd(34)} ${note ?? ''}`)
  }
  console.log(`\n${pass}/${checks.length} 通过\n`)
  if (pass !== checks.length) process.exit(1)
}

main()
