/**
 * 固定种子的回归任务集（Phase 3 的「考卷」）
 *
 * 每个任务长这样：
 *   ① 读 target 文件 —— 里面埋了一个精确值 secret
 *   ② 中间再读若干大文件 —— 制造上下文膨胀，把 target 的结果挤到历史早期
 *   ③ 最后被问「刚才那个值是多少」
 *
 * 为什么必须这样设计：压缩的代价不是「字数变少」，而是**埋在早期工具结果里的
 * 精确值还能不能被引用**。只有让任务强制「埋值 → 隔几轮 → 引用」，
 * 才能量出「引用丢失率」这个指标。随便聊几句做压缩实验是测不出东西的。
 *
 * 全部内容由固定种子 LCG 生成，不联网、不随机 —— 20 个任务可以重复跑，
 * 两次独立运行的结果必须逐字节一致，这是「N 个任务回归可复现」的来源。
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface EvalTask {
  id: string
  /** 埋在 target 文件里的精确值，模型必须在最终答案里原样引用 */
  secret: string
  targetPath: string
  noisePaths: string[]
  question: string
}

export interface EvalFixture {
  root: string
  tasks: EvalTask[]
}

export const TASK_COUNT = 20
export const NOISE_ROUNDS = 5
export const DEFAULT_SEED = 20261117

/** 线性同余发生器：不用 Math.random，保证跨进程、跨机器完全一致 */
export function makeRng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 0x100000000
  }
}

/** 生成确定性的「伪源码」填充文本。全 ASCII，token 估算稳定 */
function filler(rng: () => number, lines: number, tag: string): string {
  const words = ['const', 'return', 'async', 'value', 'buffer', 'index', 'result', 'config', 'payload', 'node']
  const out: string[] = []
  for (let i = 0; i < lines; i += 1) {
    const a = words[Math.floor(rng() * words.length)]!
    const b = words[Math.floor(rng() * words.length)]!
    const n = Math.floor(rng() * 100000)
    out.push(`  ${a} ${tag}_${i} = ${b}(${n}); // ${'x'.repeat(20 + Math.floor(rng() * 40))}`)
  }
  return out.join('\n')
}

/** 只生成任务描述，不碰磁盘 —— 用来断言「任务集可复现」 */
export function buildTasks(count = TASK_COUNT, seed = DEFAULT_SEED): EvalTask[] {
  const rng = makeRng(seed)
  const tasks: EvalTask[] = []
  for (let i = 0; i < count; i += 1) {
    const id = `task-${String(i + 1).padStart(2, '0')}`
    const block = Math.floor(rng() * 0xffffff).toString(16).toUpperCase().padStart(6, '0')
    const secret = `VLT-${block.slice(0, 4)}-${block.slice(4)}`
    tasks.push({
      id,
      secret,
      targetPath: `${id}-target.txt`,
      noisePaths: Array.from({ length: NOISE_ROUNDS }, (_, k) => `${id}-noise-${k + 1}.txt`),
      question: `请给出文件 ${id}-target.txt 中 SECRET 标记的精确值。`,
    })
  }
  return tasks
}

/** 把任务集写成真实文件，交给 ReadTool 去读（不做假，走完整工具链） */
export function materialize(tasks: EvalTask[], seed = DEFAULT_SEED): EvalFixture {
  const root = mkdtempSync(join(tmpdir(), 'agent-runtime-eval-'))
  const rng = makeRng(seed ^ 0x5f3759df)
  for (const t of tasks) {
    const head = filler(rng, 70, `${t.id}_head`)
    const secretLine = `SECRET: ${t.secret}`
    const tail = filler(rng, 70, `${t.id}_tail`)
    writeFileSync(join(root, t.targetPath), `module ${t.id}\n${head}\n${secretLine}\n${tail}\n`, 'utf8')
    t.noisePaths.forEach((p, k) => {
      writeFileSync(join(root, p), `module ${t.id}_noise_${k + 1}\n${filler(rng, 140, `n${k}`)}\n`, 'utf8')
    })
  }
  return { root, tasks }
}

/** 只清理本次 mkdtemp 创建的目录，不触碰任何用户文件 */
export function cleanup(fixture: EvalFixture): void {
  rmSync(fixture.root, { recursive: true, force: true })
}
