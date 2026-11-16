/**
 * Trace 持久化（补上 Phase 1 留下的缺口）
 *
 * Phase 1 起主循环就每轮埋一条 TurnTrace，但它只活在内存里 —— 进程一退，
 * 「上下文增长曲线」「哪一轮触发了压缩」「省了多少钱」全部消失。
 * 离线 Eval 和可视化看板都不可能建立在会蒸发的数据上，所以这一层必须补。
 *
 * 存储格式沿用 JSONL（一行一条）：既能 `cat` 着看，也能被任何日志系统、
 * pandas、jq 直接吃掉，还能增量追加而不必重写整个文件。
 *
 * 两条与 server/log.ts 相同的硬规矩：
 *  1. 写盘失败自己吞掉，留在内存副本里 —— 观测设施不许把主流程搞挂。
 *  2. 只记结构化数字与事件，不记文件内容（工具原文可能含密钥）。
 */

import { appendFileSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import type { TurnTrace } from './runAgent.js'
import type { CompactionEvent } from './compaction.js'

export interface TraceRecord {
  ts: string
  runId: string
  seq: number
  trace: TurnTrace
}

export interface TraceSummary {
  turns: number
  inputTokens: number
  outputTokens: number
  costUSD: number
  toolCalls: number
  deniedTools: number
  retries: number
  /** 累计因压缩少发给模型的 token —— 换算成钱就是压缩的真实收益 */
  compactionSavedTokens: number
  compactions: number
  collapsedResults: number
}

/** 对一组 trace 求和。Eval 的三组对照全靠这个函数取数 */
export function summarizeTraces(traces: TurnTrace[]): TraceSummary {
  const s: TraceSummary = {
    turns: traces.length,
    inputTokens: 0,
    outputTokens: 0,
    costUSD: 0,
    toolCalls: 0,
    deniedTools: 0,
    retries: 0,
    compactionSavedTokens: 0,
    compactions: 0,
    collapsedResults: 0,
  }
  for (const t of traces) {
    s.inputTokens += t.inputTokens
    s.outputTokens += t.outputTokens
    s.costUSD += t.costUSD
    s.toolCalls += t.toolUses.length
    s.deniedTools += t.deniedTools
    s.retries += t.retries
    s.compactionSavedTokens += t.compactionSavedTokens
    for (const e of t.compactionEvents) {
      if (e.applied) s.compactions += 1
      s.collapsedResults += e.collapsedCount
    }
  }
  return s
}

/** 从一组 trace 里摘出全部压缩事件，供看板画「何时动手」的时间线 */
export function compactionTimeline(traces: TurnTrace[]): CompactionEvent[] {
  return traces.flatMap((t) => t.compactionEvents)
}

export class TraceStore {
  /** 内存副本：测试与本次运行直接读它，不用等落盘 */
  readonly records: TraceRecord[] = []
  private readonly file: string | null
  private seq = 0

  constructor(
    dir: string | null,
    private readonly runId: string,
  ) {
    this.file = dir ? join(dir, `traces-${runId}.jsonl`) : null
  }

  get path(): string | null {
    return this.file
  }

  /** 实现 Tracer 接口，可直接传给 runAgent({ tracer }) */
  onTurn(trace: TurnTrace): void {
    this.seq += 1
    const rec: TraceRecord = {
      ts: new Date().toISOString(),
      runId: this.runId,
      seq: this.seq,
      trace,
    }
    this.records.push(rec)
    this.append(rec)
  }

  get traces(): TurnTrace[] {
    return this.records.map((r) => r.trace)
  }

  summary(): TraceSummary {
    return summarizeTraces(this.traces)
  }

  private append(rec: TraceRecord): void {
    if (!this.file) return
    try {
      mkdirSync(dirname(this.file), { recursive: true })
      appendFileSync(this.file, JSON.stringify(rec) + '\n')
    } catch (err) {
      process.stderr.write(`[trace] 写盘失败（已忽略）：${String(err)}\n`)
    }
  }
}

/** 读回一个 JSONL 文件。坏行跳过而不是整个文件报废 */
export function readTraceFile(path: string): TraceRecord[] {
  let raw: string
  try {
    raw = readFileSync(path, 'utf8')
  } catch {
    return []
  }
  const out: TraceRecord[] = []
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    try {
      const rec = JSON.parse(line) as TraceRecord
      if (rec && rec.trace) out.push(rec)
    } catch {
      /* 半行写入（进程被 kill）是正常现象，跳过即可 */
    }
  }
  return out
}

/** 列出目录下所有 trace 文件并汇总，用于「N 个任务回归」的离线统计 */
export function readTraceDir(dir: string): TraceRecord[] {
  let files: string[]
  try {
    files = readdirSync(dir).filter((f) => f.startsWith('traces-') && f.endsWith('.jsonl'))
  } catch {
    return []
  }
  return files.sort().flatMap((f) => readTraceFile(join(dir, f)))
}
