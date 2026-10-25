/**
 * 结构化日志（JSONL）
 *
 * 为什么不用 console.log：
 *   console.log 打出来的是给人看的文本，机器读不了。生产环境里日志要能被
 *   采集、查询、告警 —— 所以必须是结构化的。一行一条 JSON，是事实标准：
 *   既能 `cat` 着看，也能被任何日志系统直接吃掉。
 *
 * 两条硬规矩：
 *  1. 【日志绝不许把服务搞挂】写盘失败要自己吞掉，只往 stderr 抱怨一句。
 *     日志是辅助设施，它出故障不该拖垮主流程 —— 这是生产事故的经典诱因。
 *  2. 【敏感内容要脱敏】工具结果可能含密钥，落盘前截断。
 */

import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

export type LogLevel = 'info' | 'warn' | 'error'

export interface LogRecord {
  ts: string
  level: LogLevel
  event: string
  [key: string]: unknown
}

export class JsonlLogger {
  /** 内存副本：测试直接断言它，不用读盘 */
  readonly records: LogRecord[] = []

  constructor(
    private readonly dir: string | null,
    private readonly base: Record<string, unknown> = {},
  ) {}

  /** 派生一个带固定字段的子 logger（比如固定 sessionId） */
  child(base: Record<string, unknown>): JsonlLogger {
    const l = new JsonlLogger(this.dir, { ...this.base, ...base })
    // 子 logger 的记录也汇总到父级，测试只需看一份
    l.sink = (r) => this.records.push(r)
    return l
  }

  private sink: ((r: LogRecord) => void) | null = null

  write(event: string, fields: Record<string, unknown> = {}, level: LogLevel = 'info'): LogRecord {
    const rec: LogRecord = {
      ts: new Date().toISOString(),
      level,
      event,
      ...this.base,
      ...fields,
    }
    this.records.push(rec)
    this.sink?.(rec)

    if (this.dir) {
      try {
        mkdirSync(this.dir, { recursive: true })
        appendFileSync(join(this.dir, `${dayStamp()}.jsonl`), JSON.stringify(rec) + '\n')
      } catch (err) {
        // 见文件头第 1 条：日志故障不能影响主流程
        process.stderr.write(`[log] 写盘失败（已忽略）：${String(err)}\n`)
      }
    }
    return rec
  }

  info(event: string, fields?: Record<string, unknown>): LogRecord {
    return this.write(event, fields, 'info')
  }
  warn(event: string, fields?: Record<string, unknown>): LogRecord {
    return this.write(event, fields, 'warn')
  }
  error(event: string, fields?: Record<string, unknown>): LogRecord {
    return this.write(event, fields, 'error')
  }
}

/** 截断长文本，避免把整个文件内容写进日志 */
export function clip(s: string, max = 500): string {
  return s.length <= max ? s : `${s.slice(0, max)}…[+${s.length - max} 字符]`
}

function dayStamp(): string {
  return new Date().toISOString().slice(0, 10)
}
