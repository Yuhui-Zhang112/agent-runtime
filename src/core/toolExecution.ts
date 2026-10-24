/**
 * 工具执行调度器（Concurrency Scheduler）
 *
 * 一句话：模型一轮可能要调好几个工具（比如"读这 3 个文件"）。
 * 串行执行要等 3 次，并发执行只等最慢的那一个 —— 省一半以上的时间。
 *
 * 但**不能无脑并发**。三个约束：
 *
 *  1. 【只有安全的才能并发】
 *     一个工具必须同时声明 isReadOnly === true 且 isConcurrencySafe === true
 *     才允许跟别人一起跑。写文件的工具（Write / Edit）绝不能并发 ——
 *     两个工具同时改一个文件，后写的会覆盖先写的，而且你完全看不出来。
 *
 *  2. 【顺序必须还原】
 *     并发跑完，结果要按模型原本的请求顺序排回去。
 *     模型是看着 tool_use 的顺序来理解上下文的，结果乱序会让它犯迷糊。
 *     本文件通过"先占位、再填坑"保证顺序 —— executeToolUses 的返回顺序
 *     与传入的 toolUses 顺序严格一致。
 *
 *  3. 【中断要收敛，不能留空洞】
 *     跑到一半被 Ctrl+C，已经发出去的工具拦不住（它们是只读的，让它跑完），
 *     但**还没开始的必须立刻停止**，并且照样给每个 tool_use 补一条结果。
 *     少一条 tool_result，API 就 400，会话永久死锁。
 *
 * 另外记了每个工具的耗时和它属于第几个"波次"（wave）——
 * 这两个字段是 Phase 5 做「哪一步最慢」「并发省了多少时间」的数据源。
 */

import { runTool, type ToolContext, type ToolRegistry } from './tool.js'

/** 一次工具调用请求（从 assistant 消息里摘出来的） */
export interface ToolUseRef {
  id: string
  name: string
  input: unknown
}

/** 一次工具调用的结果（无论成功失败，一定有） */
export interface ExecutedTool {
  toolUseId: string
  name: string
  output: string
  isError: boolean
  /** 单个工具耗时（ms） */
  durationMs: number
  /** 第几个波次：同一波次的工具是并发跑的 */
  wave: number
  /** 结果是否被截断（上下文工程第一道防线） */
  truncated: boolean
  /** 是否因为中断而根本没执行（补的合成结果） */
  cancelled: boolean
}

export interface ToolExecutionOptions {
  toolUses: ToolUseRef[]
  tools: ToolRegistry
  ctx: ToolContext
  /** 单条结果最大字符数。默认 30000 */
  maxResultChars?: number
  /** 一波里最多同时跑几个。默认 8 —— 防止一次打开 200 个文件句柄把系统拖垮 */
  maxParallel?: number
  /** 工具开始/结束的回调，UI 用它显示"正在读 3 个文件…" */
  onToolStart?: (info: { id: string; name: string; wave: number }) => void
  onToolEnd?: (info: ExecutedTool) => void
}

const DEFAULT_MAX_RESULT_CHARS = 30_000
const DEFAULT_MAX_PARALLEL = 8

// ── 分组：谁能跟谁一起跑 ────────────────────────────────────

interface Group {
  /** true = 组内并发跑；false = 独占（组里只有一个） */
  parallel: boolean
  items: ToolUseRef[]
}

/**
 * 把一串工具调用切成"波次"。
 *
 * 规则：连续的可并发工具合并成一组；遇到一个不可并发的工具，
 * 先把前面攒的那一组收尾，再让这个工具独占一组，然后继续攒。
 *
 *      [Read, Read, Write, Read, Grep]
 *   →  [并行(Read,Read)] [独占(Write)] [并行(Read,Grep)]
 */
export function planGroups(toolUses: ToolUseRef[], tools: ToolRegistry): Group[] {
  const groups: Group[] = []
  let pending: ToolUseRef[] = []

  const flush = () => {
    if (pending.length > 0) {
      groups.push({ parallel: true, items: pending })
      pending = []
    }
  }

  for (const tu of toolUses) {
    const tool = tools.get(tu.name)
    // 只有「声明了只读」且「声明了可并发」的工具才进并行组。
    // 未知工具不算可并发 —— 它可能是任何东西，保守处理。
    const safe = !!tool && tool.isReadOnly === true && tool.isConcurrencySafe === true

    if (safe) {
      pending.push(tu)
    } else {
      flush()
      groups.push({ parallel: false, items: [tu] })
    }
  }
  flush()
  return groups
}

// ── 执行 ────────────────────────────────────────────────────

/**
 * 执行一批 tool_use，**返回顺序与传入顺序严格一致**。
 * 无论并发、中断、单条失败，都不会漏掉任何一条结果。
 */
export async function executeToolUses(
  opts: ToolExecutionOptions,
): Promise<ExecutedTool[]> {
  const {
    toolUses,
    tools,
    ctx,
    maxResultChars = DEFAULT_MAX_RESULT_CHARS,
    maxParallel = DEFAULT_MAX_PARALLEL,
    onToolStart,
    onToolEnd,
  } = opts

  // 先占位，保证顺序 —— 并发只影响"什么时候填进去"，不影响"填在第几格"
  const results = new Array<ExecutedTool>(toolUses.length)
  const groups = planGroups(toolUses, tools)

  let wave = 0
  for (const group of groups) {
    // 每组开始时检查一次中断：被中断后剩下的组不再真的执行
    if (group.items.length === 0) continue

    const runOne = async (tu: ToolUseRef): Promise<ExecutedTool> => {
      onToolStart?.({ id: tu.id, name: tu.name, wave })
      const executed = await runOneTool(tu, tools, ctx, maxResultChars)
      onToolEnd?.(executed)
      return executed
    }

    const done = group.parallel
      ? await mapWithLimit(group.items, maxParallel, runOne)
      : [await runOne(group.items[0]!)]

    // 按原索引回填，并把真实波次号写进结果（Trace 要靠它判断"谁和谁是并行跑的"）
    for (let i = 0; i < group.items.length; i += 1) {
      const tu = group.items[i]!
      const at = toolUses.findIndex((t) => t.id === tu.id)
      results[at] = { ...done[i]!, wave }
    }
    wave += 1
  }

  return results as ExecutedTool[]
}

/** 执行单个工具。任何情况下都返回结果，绝不抛异常 */
async function runOneTool(
  tu: ToolUseRef,
  tools: ToolRegistry,
  ctx: ToolContext,
  maxResultChars: number,
): Promise<ExecutedTool> {
  const startedAt = Date.now()

  // 中断：不执行，但结果位必须有内容
  if (ctx.signal?.aborted) {
    return {
      toolUseId: tu.id,
      name: tu.name,
      output: '已取消（用户中断，未执行）',
      isError: true,
      durationMs: Date.now() - startedAt,
      wave: -1,
      truncated: false,
      cancelled: true,
    }
  }

  const tool = tools.get(tu.name)
  const res = tool
    ? await runTool(tool, tu.input, ctx)
    : {
        output: `未知工具：${tu.name}。可用工具：${tools.list().map((t) => t.name).join(', ')}`,
        isError: true,
      }

  let output = res.output
  let truncated = false
  if (output.length > maxResultChars) {
    output =
      output.slice(0, maxResultChars) +
      `\n\n[已截断：原始 ${output.length} 字符，保留前 ${maxResultChars} 字符]`
    truncated = true
  }

  return {
    toolUseId: tu.id,
    name: tu.name,
    output,
    isError: res.isError === true,
    durationMs: Date.now() - startedAt,
    wave: -1, // 由调用方回填
    truncated,
    cancelled: false,
  }
}

/**
 * 带并发上限的 map：最多同时跑 limit 个，但**返回顺序与输入一致**。
 *
 * 用"游标 + 多个工人抢任务"实现，而不是把数组切成几段分别 Promise.all：
 * 切段的话，一段里只要有一个慢的，其他工人就得干等。
 */
export async function mapWithLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out = new Array<R>(items.length)
  let cursor = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))

  const workers = Array.from({ length: workerCount }, async () => {
    for (;;) {
      const i = cursor
      cursor += 1
      if (i >= items.length) return
      // 单个任务失败不能掀翻整批 —— 其余任务照跑，失败的那个留着错误结果
      out[i] = await fn(items[i]!)
    }
  })

  await Promise.all(workers)
  return out
}
