/**
 * 场景 Agent：开源项目 issue 定位（L2 示范应用，跑在自研 runtime 上）
 *
 * 这个目录回答面试官那句「那你这东西到底能干什么」：
 *   给 Agent 一份 issue，它用 Grep 搜报错码 → Read 读嫌疑文件 →
 *   输出结构化结论（根因文件 / 缺陷类型 / 精确证据标记 / 修复建议）。
 *
 * 与「调 LangChain 拼一个 RAG 问答」的区别：
 *   工具真的走 ToolRegistry、权限预检、并发调度、主循环、压缩和 Trace；
 *   结论用 zod 校验并和 ground truth 自动判分，所以它是一个**可评测的应用**，
 *   不是一个只能演示的界面。
 *
 * 诚实边界：驱动它的是一个确定性的、会读历史的假模型（零 API key）。
 * 它验证的是「证据在上下文里是否可达」这条架构机制，不验证真 LLM 的推理能力。
 * 换成真 provider 时，这里只需换 provider，其余代码不动。
 */

import { z } from 'zod'
import type { ModelProvider, ModelRequest, StreamEvent } from '../api/types.js'
import { buildEvents, type ScriptedBlock } from '../core/streamEvents.js'
import { runAgent, type RunAgentResult } from '../core/runAgent.js'
import type { CompactionPolicy, CompactionEvent } from '../core/compaction.js'
import { summarizeTraces, type TraceSummary } from '../core/traceStore.js'
import { ToolRegistry } from '../core/tool.js'
import { GlobTool } from '../tools/GlobTool.js'
import { GrepTool } from '../tools/GrepTool.js'
import { ReadTool } from '../tools/ReadTool.js'
import { createUserMessage, estimateTokens, type Message } from '../types/message.js'
import { CATEGORIES, type IssueTask } from './issueFixtures.js'

export const SCENARIO_MODEL = 'claude-sonnet-4'
/** 与压缩实验同一套计价口径：输入 $3 / 输出 $15 per 1M tokens */
export const INPUT_PRICE_PER_M = 3
export const OUTPUT_PRICE_PER_M = 15
export const UNKNOWN_CATEGORY = 'unknown'

export const SCENARIO_SYSTEM =
  'You are an issue-triage agent for a TypeScript repository. ' +
  'Workflow: (1) Grep the error code to locate candidate files, ' +
  '(2) Read the suspect file to extract the exact bug marker, ' +
  '(3) answer with ONE JSON object only: ' +
  '{"category","rootFile","evidence","fix","confidence"}. ' +
  'category must be one of off-by-one / null-check / race-condition / encoding / config / unknown. ' +
  'If a tool result was folded and the evidence is unavailable, follow the placeholder hint and Read the file again. ' +
  'Never invent an evidence marker. If you truly cannot recover it, answer with category="unknown" and empty evidence.'

export const IssueAnalysisSchema = z.object({
  category: z.union([z.enum(CATEGORIES), z.literal(UNKNOWN_CATEGORY)]),
  rootFile: z.string(),
  evidence: z.string(),
  fix: z.string(),
  confidence: z.number().min(0).max(1),
})
export type IssueAnalysis = z.infer<typeof IssueAnalysisSchema>

/** 从最终回复里抠出 JSON（模型可能包在 ```json 代码块里） */
export function parseAnalysis(text: string): IssueAnalysis | null {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/i.exec(text)
  const candidate = fenced?.[1] ?? text
  const start = candidate.indexOf('{')
  const end = candidate.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const parsed = IssueAnalysisSchema.safeParse(JSON.parse(candidate.slice(start, end + 1)))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}

export interface IssueScore {
  valid: boolean
  fileHit: boolean
  categoryHit: boolean
  evidenceHit: boolean
  /** 三项全中才算这个任务被解决 */
  success: boolean
  /** 证据没取回（模型承认不知道 / 结论无效） */
  evidenceLost: boolean
}

export function scoreAnalysis(analysis: IssueAnalysis | null, task: IssueTask): IssueScore {
  const fileHit = analysis !== null && analysis.rootFile === task.rootFile
  const categoryHit = analysis !== null && analysis.category === task.category
  const evidenceHit = analysis !== null && analysis.evidence === task.evidence
  const valid = analysis !== null && analysis.category !== UNKNOWN_CATEGORY && analysis.evidence !== ''
  return {
    valid,
    fileHit,
    categoryHit,
    evidenceHit,
    success: fileHit && categoryHit && evidenceHit,
    evidenceLost: !evidenceHit,
  }
}

export function issueToolRegistry(): ToolRegistry {
  return new ToolRegistry().register(GlobTool, GrepTool, ReadTool)
}

/** 摊平历史，判断「精确证据此刻还在不在上下文里」 */
export function flattenIssueHistory(messages: Message[]): string {
  const parts: string[] = []
  for (const m of messages) {
    if (m.type === 'user') {
      if (typeof m.message.content === 'string') parts.push(m.message.content)
      else {
        for (const b of m.message.content) {
          if (b.type === 'tool_result' && typeof b.content === 'string') parts.push(b.content)
          else if (b.type === 'text') parts.push(b.text)
        }
      }
    } else if (m.type === 'assistant') {
      for (const b of m.message.content) if (b.type === 'text') parts.push(b.text)
    }
  }
  return parts.join('\n')
}

/** 按这一轮真正发出去的 messages 现算输入 token（与压缩实验同一把尺子） */
export function estimateIssueRequestTokens(req: ModelRequest): number {
  const history = req.messages.reduce((s, m) => s + estimateTokens(m), 0)
  const system = Math.ceil(req.system.length / 4)
  const tools = Math.ceil(JSON.stringify(req.tools).length / 4)
  return history + system + tools
}

export interface IssueProviderOptions {
  task: IssueTask
  /** 是否允许按占位符提示回去重读。退化对照组设 false */
  allowRecovery: boolean
  noiseRounds?: number
  outputTokens?: number
}

/**
 * 会读历史的确定性场景模型。
 * 关键性质：结论**只能从历史里真实存在的证据得出**，历史被压缩折叠后
 * 若取不回证据，它就只能承认不知道 —— 于是「压缩是否伤了业务任务」可量化。
 */
export class IssueProvider implements ModelProvider {
  readonly name = 'issue-scenario'
  calls = 0
  recoveries = 0
  readonly inputTokens: number[] = []
  readonly requests: ModelRequest[] = []

  constructor(private readonly opts: IssueProviderOptions) {}

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    this.calls += 1
    this.requests.push(req)
    const inputTokens = estimateIssueRequestTokens(req)
    this.inputTokens.push(inputTokens)

    const turn = {
      blocks: this.decide(req),
      usage: {
        input_tokens: inputTokens,
        output_tokens: this.opts.outputTokens ?? 80,
      },
    }
    for (const ev of buildEvents(turn, 64, req.model)) {
      if (req.signal?.aborted) return
      yield ev
    }
  }

  private decide(req: ModelRequest): ScriptedBlock[] {
    const { task, allowRecovery } = this.opts
    const noiseRounds = this.opts.noiseRounds ?? 3
    const n = this.calls

    if (n === 1) {
      return [
        tool(n, 'Grep', {
          pattern: task.keyword,
          path: 'src/modules',
          include: '*.ts',
          maxMatches: 20,
        }),
      ]
    }
    if (n === 2) return [tool(n, 'Read', { path: task.rootFile })]
    if (n <= 2 + noiseRounds) {
      const path = task.noisePaths[(n - 3) % task.noisePaths.length]!
      return [tool(n, 'Read', { path })]
    }

    const history = flattenIssueHistory(req.messages)
    if (history.includes(task.evidence) && history.includes(task.rootFile)) {
      return [{ type: 'text', text: JSON.stringify(makeAnalysis(task)) }]
    }

    // 证据被折叠了：占位符里留了原路径 → 按需重新 Read 取回
    if (allowRecovery && this.recoveries === 0 && history.includes('[上下文压缩]')) {
      this.recoveries += 1
      return [tool(n, 'Read', { path: task.rootFile })]
    }

    return [{ type: 'text', text: JSON.stringify(makeUnknown()) }]
  }
}

function tool(turn: number, name: string, input: unknown): ScriptedBlock {
  return { type: 'tool_use', id: `tu_issue_${turn}`, name, input }
}

function makeAnalysis(task: IssueTask): IssueAnalysis {
  return {
    category: task.category,
    rootFile: task.rootFile,
    evidence: task.evidence,
    fix: task.hint,
    confidence: 0.92,
  }
}

function makeUnknown(): IssueAnalysis {
  return {
    category: UNKNOWN_CATEGORY,
    rootFile: '',
    evidence: '',
    fix: '证据不可达，需重新读取根因文件',
    confidence: 0,
  }
}

export interface IssueRunOptions {
  task: IssueTask
  /** fixture 仓库根目录 —— 所有文件操作被锁在这里面 */
  root: string
  /** null / 不传 = 不压缩（基线组） */
  compaction?: Partial<CompactionPolicy> | null
  allowRecovery?: boolean
  noiseRounds?: number
  maxTurns?: number
}

export interface IssueRun {
  task: IssueTask
  result: RunAgentResult
  provider: IssueProvider
  analysis: IssueAnalysis | null
  score: IssueScore
  summary: TraceSummary
  compactionEvents: CompactionEvent[]
  costUSD: number
}

/** 跑一个 issue：完整走过主循环、工具系统、可选压缩与 Trace */
export async function runIssueAgent(opts: IssueRunOptions): Promise<IssueRun> {
  const provider = new IssueProvider({
    task: opts.task,
    allowRecovery: opts.allowRecovery ?? true,
    ...(opts.noiseRounds !== undefined ? { noiseRounds: opts.noiseRounds } : {}),
  })
  const messages: Message[] = [createUserMessage(opts.task.issueText)]
  const compactionEvents: CompactionEvent[] = []

  const result = await runAgent({
    provider,
    model: SCENARIO_MODEL,
    system: SCENARIO_SYSTEM,
    tools: issueToolRegistry(),
    messages,
    cwd: opts.root,
    maxTurns: opts.maxTurns ?? 20,
    compaction: opts.compaction ?? null,
    onCompaction: (e) => compactionEvents.push(e),
  })

  const analysis = parseAnalysis(result.finalText)
  const summary = summarizeTraces(result.traces)
  const costUSD =
    (summary.inputTokens / 1_000_000) * INPUT_PRICE_PER_M +
    (summary.outputTokens / 1_000_000) * OUTPUT_PRICE_PER_M

  return {
    task: opts.task,
    result,
    provider,
    analysis,
    score: scoreAnalysis(analysis, opts.task),
    summary,
    compactionEvents,
    costUSD,
  }
}
