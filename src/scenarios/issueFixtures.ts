/**
 * 场景数据：一个「开源项目 + issue 列表」的最小可判分副本
 *
 * 为什么需要造 fixture 而不是抓真实 issue：
 *   真实 issue 没有 ground truth —— 谁也说不清「正确答案该定位到哪个文件」，
 *   于是评测只能靠人肉感觉。这里每份 issue 都对应一份带标记的代码，
 *   「根因文件 / 缺陷类型 / 证据标记」三项都是已知的，结论可以自动判分。
 *
 * 诚实边界（写进报告）：这是**结构真实、内容合成**的仓库。
 * 它验证的是「Agent 能不能在工具结果被折叠后仍找回证据」这条机制，
 * 不是「它能解决真实 GitHub issue」。
 */

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/** 确定性 LCG。生产层不引用 dev/（构建时该目录被排除），这里保留同款实现 */
function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

export const ISSUE_COUNT = 12
export const ISSUE_SEED = 20261118
export const NOISE_FILES_PER_ISSUE = 3

export const CATEGORIES = [
  'off-by-one',
  'null-check',
  'race-condition',
  'encoding',
  'config',
] as const

export type IssueCategory = (typeof CATEGORIES)[number]

export interface IssueTask {
  id: string
  /** issue 里出现的报错码，也是 Grep 的搜索词 */
  keyword: string
  /** 只有读到根因文件才拿得到的精确标记 */
  evidence: string
  /** ground truth：应该定位到的文件 */
  rootFile: string
  category: IssueCategory
  /** issue 正文（发给模型的第一条消息） */
  issueText: string
  /** 制造上下文膨胀的噪音文件 */
  noisePaths: string[]
  /** 期望的修复方向，用于报告里展示，不参与判分 */
  hint: string
}

export interface IssueFixture {
  root: string
  cleanup(): void
}

/** 固定种子 → 每次生成的仓库与 issue 完全一致，实验可复现 */
export function buildIssues(count = ISSUE_COUNT, seed = ISSUE_SEED): IssueTask[] {
  const rng = makeRng(seed)
  const tasks: IssueTask[] = []

  for (let i = 1; i <= count; i += 1) {
    const id = `ISSUE-${i}`
    const keyword = `ERR-${1000 + i * 7}`
    const evidence = `BUG-${i}-${Math.floor(rng() * 9000 + 1000)}`
    const category = CATEGORIES[(i - 1) % CATEGORIES.length]!
    const rootFile = `src/modules/handler-${i}.ts`
    const noisePaths = Array.from(
      { length: NOISE_FILES_PER_ISSUE },
      (_, j) => `src/legacy/noise-${i}-${String.fromCharCode(97 + j)}.ts`,
    )

    tasks.push({
      id,
      keyword,
      evidence,
      rootFile,
      category,
      noisePaths,
      hint: FIX_HINTS[category],
      issueText: [
        `# ${id}: unexpected result in handler-${i}`,
        '',
        `**Error code**: \`${keyword}\``,
        `**Component**: \`${rootFile}\``,
        '',
        '## Steps to reproduce',
        '1. Run the handler with an empty or boundary input.',
        '2. Observe an incorrect value instead of the documented result.',
        '',
        '## What we need',
        'Find the file that actually causes the bug, quote the exact marker in that file,',
        'classify the defect, and suggest a fix. Search the repository before answering.',
      ].join('\n'),
    })
  }
  return tasks
}

const FIX_HINTS: Record<IssueCategory, string> = {
  'off-by-one': '把 <= 改成 <，并对空输入做边界保护',
  'null-check': '在解引用前判空，给可选字段一个明确默认值',
  'race-condition': '把共享状态的读改写包进同一个临界区',
  encoding: '统一按 UTF-8 解码，别按字节下标切字符串',
  config: '读取配置时补默认值，别让缺失字段变成 undefined',
}

const CATEGORY_SNIPPET: Record<IssueCategory, string> = {
  'off-by-one': 'for (let i = 0; i <= items.length; i += 1) total += items[i] ?? 0',
  'null-check': 'const name = user.profile.displayName.trim()',
  'race-condition': 'this.counter = this.counter + pending.length',
  encoding: 'return raw.slice(0, byteLength).toString("ascii")',
  config: 'const timeout = cfg.timeoutMs * factor',
}

/** 造一份真实目录：issue 文本 + 根因文件 + 噪音文件，全部落在临时目录里 */
export function materializeIssues(tasks: IssueTask[], seed = ISSUE_SEED): IssueFixture {
  const root = mkdtempSync(join(tmpdir(), 'agent-runtime-issues-'))
  const rng = makeRng(seed + 1)

  mkdirSync(join(root, 'issues'), { recursive: true })
  mkdirSync(join(root, 'src', 'modules'), { recursive: true })
  mkdirSync(join(root, 'src', 'legacy'), { recursive: true })
  writeFileSync(join(root, 'README.md'), '# fixture repo\n\nSynthetic repository for issue triage eval.\n')

  for (const t of tasks) {
    writeFileSync(join(root, 'issues', `${t.id}.md`), t.issueText + '\n')
    writeFileSync(
      join(root, t.rootFile),
      [
        `// ${t.keyword}: reported by ${t.id}`,
        `// ${t.evidence} · ROOT_CAUSE: ${t.category}`,
        'export interface Input { items: number[]; raw?: string }',
        '',
        // 常规实现代码：让根因文件有真实源文件的体积（> 压缩的 minResultChars），
        // 否则它太小不会被折叠，A/B/C 三组就测不出差异。
        ...Array.from({ length: 20 }, (_, k) => `const pad${k} = (x: number): number => (x * ${k + 3}) % 9973`),
        '',
        `export function handle(input: Input): number {`,
        `  // ${t.evidence}: the defect lives on the next line`,
        `  ${CATEGORY_SNIPPET[t.category]}`,
        '  return 0',
        '}',
        '',
        `// hint: ${t.hint}`,
        '',
      ].join('\n'),
    )

    for (const p of t.noisePaths) {
      // 单份 ~12k 字符：确保上下文会越过压缩阈值，且不掺入证据标记
      const lines: string[] = [
        `// legacy module ${p} — intentionally large, no bug markers here`,
        'export const LEGACY_TABLE = {',
      ]
      for (let k = 0; k < 220; k += 1) {
        lines.push(`  k${k}: ${Math.floor(rng() * 100000)}.${Math.floor(rng() * 100000)},`)
      }
      lines.push('}', '', 'export function noop(x: number): number { return x + 1 }', '')
      writeFileSync(join(root, p), lines.join('\n'))
    }
  }

  return {
    root,
    cleanup: () => {
      try {
        rmSync(root, { recursive: true, force: true })
      } catch {
        /* 临时目录清理失败不影响结论 */
      }
    },
  }
}
