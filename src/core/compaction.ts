/**
 * 上下文压缩（Phase 3 的核心）
 *
 * ── 为什么非压不可 ────────────────────────────────────────
 * 模型没有长期记忆：每一轮都要把之前的全部历史重新发一遍。
 * Agent 比聊天更惨 —— 每调一次工具就把工具结果塞进历史，读一个文件
 * 动辄几千 token。于是三个问题同时来：撞窗口上限、成本按轮累加、
 * 模型在超长历史里找关键信息的准确率下降。
 *
 * 关键洞察：**占地方的不是对话，是大块 tool_result**。
 *
 * ── 为什么这样压 ──────────────────────────────────────────
 * 常见三种做法：
 *   1. 滑窗截断：扔掉最早几条。最简单，但很容易把 tool_use 扔了留下
 *      tool_result（或反过来）—— 配对一断，API 直接 400，会话永久死锁。
 *   2. 摘要压缩：再调一次模型写摘要。省得多，但多花一次调用，且摘要
 *      天生会漏掉精确数字（行号、错误码、埋在文件里的值）。
 *   3. 结构化手术（本文件）：不删任何消息，只把**大块 tool_result 的
 *      文本**换成一句占位符。信息不是删了，是「收进抽屉」——占位符写明
 *      原文件路径，模型想看时再调一次 Read 取回。
 *
 * 选第 3 种的真正理由：只有自己定义消息类型、自己保证配对，才碰得到
 * 消息树这一层。框架使用者在应用层看不到 tool_result 块，压缩对他们
 * 是框架内部的黑盒 —— 这正是本项目能做 A/B 评测的原因。
 *
 * ── 四条铁律 ──────────────────────────────────────────────
 *  【纯函数】不修改入参数组，返回新数组。方便测试、方便对照实验。
 *  【配对不可断】只改 tool_result 的文本，绝不删块、绝不删消息，
 *      uuid / parentUuid 全部原样保留，消息树链条不断。
 *  【最近不碰】末尾 N 条消息完全不动 —— 模型正在用的上下文不能被抽走。
 *  【自检回滚】压完逐条体检，任意一条不过就整套丢弃，返回原历史。
 *      「宁可不省这点钱，也绝不把坏消息发给 API」。
 */

import {
  estimateTokens,
  findOrphanToolUseIds,
  type ContentBlock,
  type Message,
} from '../types/message.js'

// ── 策略 ────────────────────────────────────────────────────

export interface CompactionPolicy {
  /** 总开关。false = 完全不压缩（A/B 实验的基线组） */
  enabled: boolean
  /** 上下文超过这么多 token 才考虑动手。不设阈值会每轮都压，纯属折腾 */
  triggerTokens: number
  /** 目标预算：压到不超过这么多 token 就收手 */
  targetTokens: number
  /** 末尾 N 条消息完全不动 */
  protectRecentMessages: number
  /** 单条 tool_result 至少这么长才值得压（短结果压了反而亏：占位符也是 token） */
  minResultChars: number
  /** 占位符是否声明「可以重新 Read 取回」。false = 退化对照组，用来证明可恢复的价值 */
  recoverable: boolean
  /** 一次最多折叠几条，防止极端情况下遍历整个历史 */
  maxCollapsed: number
}

export const DEFAULT_COMPACTION_POLICY: CompactionPolicy = {
  enabled: true,
  triggerTokens: 6_000,
  targetTokens: 3_000,
  protectRecentMessages: 4,
  minResultChars: 600,
  recoverable: true,
  maxCollapsed: 24,
}

/** 策略归一化：非法值一律 fail-closed（抛错），不带着半懂的配置跑起来 */
export function resolveCompactionPolicy(
  partial: Partial<CompactionPolicy> = {},
): CompactionPolicy {
  const p: CompactionPolicy = { ...DEFAULT_COMPACTION_POLICY, ...partial }
  const ints: Array<keyof CompactionPolicy> = [
    'triggerTokens',
    'targetTokens',
    'protectRecentMessages',
    'minResultChars',
    'maxCollapsed',
  ]
  for (const k of ints) {
    const v = p[k] as number
    if (!Number.isInteger(v) || v <= 0) {
      throw new Error(`压缩策略 ${k} 必须是正整数，收到：${String(v)}`)
    }
  }
  if (p.targetTokens >= p.triggerTokens) {
    throw new Error(
      `压缩策略 targetTokens(${p.targetTokens}) 必须小于 triggerTokens(${p.triggerTokens})`,
    )
  }
  return p
}

// ── 结果 ────────────────────────────────────────────────────

export type CompactionReason =
  | 'ok'
  | 'disabled'
  | 'below-threshold'
  | 'no-candidate'
  | 'no-saving'
  | 'self-check-failed'

export interface CollapsedItem {
  toolUseId: string
  toolName: string
  /** 占位符里提示重新读取的路径（拿不到就为 null） */
  path: string | null
  originalChars: number
  /** 这一条折叠省下的 token */
  savedTokens: number
}

export interface CompactionSelfCheck {
  pairing: boolean
  firstMessage: boolean
  recentProtected: boolean
  uuidChain: boolean
  savedSomething: boolean
}

/** 一条压缩事件。写进 Trace / SSE / JSONL，是「监控看板」要展示的原料 */
export interface CompactionEvent {
  turn: number
  applied: boolean
  reason: CompactionReason
  triggerTokens: number
  beforeTokens: number
  afterTokens: number
  savedTokens: number
  budgetMet: boolean
  recoverable: boolean
  collapsedCount: number
  collapsed: CollapsedItem[]
}

export interface CompactionResult {
  /** 压缩后的新数组。未应用时是与入参内容相同的新数组（引用不变） */
  messages: Message[]
  applied: boolean
  reason: CompactionReason
  triggerTokens: number
  beforeTokens: number
  afterTokens: number
  savedTokens: number
  budgetMet: boolean
  collapsed: CollapsedItem[]
  selfCheck: CompactionSelfCheck
}

const PASS_CHECK: CompactionSelfCheck = {
  pairing: true,
  firstMessage: true,
  recentProtected: true,
  uuidChain: true,
  savedSomething: true,
}

// ── 主函数 ──────────────────────────────────────────────────

/**
 * 纯函数：输入历史，输出压缩后的新历史。
 *
 * 注意它**不决定「什么时候该压」之外的任何事**：不做 IO、不调模型、
 * 不写日志。这样 A/B 实验里换策略只需换一个参数，其余变量全部锁死。
 */
export function compactMessages(
  messages: Message[],
  policyInput: Partial<CompactionPolicy> = {},
): CompactionResult {
  const policy = resolveCompactionPolicy(policyInput)
  const beforeTokens = totalTokens(messages)

  const skip = (reason: CompactionReason, collapsed: CollapsedItem[] = []): CompactionResult => ({
    messages: messages.slice(),
    applied: false,
    reason,
    triggerTokens: policy.triggerTokens,
    beforeTokens,
    afterTokens: beforeTokens,
    savedTokens: 0,
    budgetMet: beforeTokens <= policy.targetTokens,
    collapsed,
    selfCheck: { ...PASS_CHECK, savedSomething: false },
  })

  if (!policy.enabled) return skip('disabled')
  if (beforeTokens <= policy.triggerTokens) return skip('below-threshold')

  // ① 建 id → 工具调用信息的索引，占位符才能写清「重新 Read 哪个文件」
  const toolCalls = new Map<string, { name: string; input: unknown }>()
  for (const m of messages) {
    if (m.type !== 'assistant') continue
    for (const b of m.message.content) {
      if (b.type === 'tool_use') toolCalls.set(b.id, { name: b.name, input: b.input })
    }
  }

  // ② 找候选：只在大块 tool_result 里动刀，且末尾 N 条消息完全跳过
  const protectedFrom = Math.max(0, messages.length - policy.protectRecentMessages)
  interface Candidate {
    messageIndex: number
    blockIndex: number
    toolUseId: string
    toolName: string
    path: string | null
    chars: number
  }
  const candidates: Candidate[] = []

  for (let mi = 0; mi < protectedFrom; mi += 1) {
    const m = messages[mi]!
    if (m.type !== 'user' || !Array.isArray(m.message.content)) continue
    m.message.content.forEach((b, bi) => {
      if (b.type !== 'tool_result' || typeof b.content !== 'string') return
      if (b.content.length < policy.minResultChars) return
      // 已经折过的不要重复压（占位符比原文短，通常也会被 minResultChars 挡住，
      // 但显式判断更稳，避免阈值调小时二次压缩）
      if (b.content.startsWith(PLACEHOLDER_PREFIX)) return
      const info = toolCalls.get(b.tool_use_id)
      candidates.push({
        messageIndex: mi,
        blockIndex: bi,
        toolUseId: b.tool_use_id,
        toolName: info?.name ?? 'unknown',
        path: extractPath(info?.input),
        chars: b.content.length,
      })
    })
  }

  if (candidates.length === 0) return skip('no-candidate')

  // ③ 先压最胖的 —— 同样的折叠次数省得最多
  candidates.sort((a, b) => b.chars - a.chars)

  const out = messages.slice()
  const collapsed: CollapsedItem[] = []
  let afterTokens = beforeTokens

  for (const c of candidates) {
    if (collapsed.length >= policy.maxCollapsed) break
    if (afterTokens <= policy.targetTokens) break

    const m = out[c.messageIndex]!
    if (m.type !== 'user' || !Array.isArray(m.message.content)) continue
    const blocks = m.message.content.slice()
    const block = blocks[c.blockIndex]
    if (!block || block.type !== 'tool_result' || typeof block.content !== 'string') continue

    const originalTokens = estimateTokens(m)
    const placeholder = makePlaceholder(c, block.content.length, policy.recoverable)
    const newBlock: ContentBlock = { ...block, content: placeholder }
    blocks[c.blockIndex] = newBlock
    const newMessage: Message = {
      ...m,
      message: { ...m.message, content: blocks },
    }
    const newTokens = estimateTokens(newMessage)
    if (newTokens >= originalTokens) continue // 压了反而更胖，跳过

    out[c.messageIndex] = newMessage
    afterTokens += newTokens - originalTokens
    collapsed.push({
      toolUseId: c.toolUseId,
      toolName: c.toolName,
      path: c.path,
      originalChars: block.content.length,
      savedTokens: originalTokens - newTokens,
    })
  }

  if (collapsed.length === 0 || afterTokens >= beforeTokens) return skip('no-saving')

  // ④ 压完体检。任意一条不过，整套丢弃 —— 回滚到原历史
  const recent = policy.protectRecentMessages
  const check: CompactionSelfCheck = {
    pairing:
      findOrphanToolUseIds(out).length === findOrphanToolUseIds(messages).length &&
      findOrphanToolUseIds(out).length === 0,
    firstMessage: out[0] === messages[0],
    recentProtected: messages.slice(-recent).every((m, i) => out[out.length - recent + i] === m),
    uuidChain: out.every(
      (m, i) => m.uuid === messages[i]?.uuid && m.parentUuid === messages[i]?.parentUuid,
    ),
    savedSomething: afterTokens < beforeTokens,
  }
  if (Object.values(check).some((ok) => !ok)) {
    return {
      ...skip('self-check-failed', collapsed),
      selfCheck: check,
      afterTokens: beforeTokens,
    }
  }

  return {
    messages: out,
    applied: true,
    reason: 'ok',
    triggerTokens: policy.triggerTokens,
    beforeTokens,
    afterTokens,
    savedTokens: beforeTokens - afterTokens,
    budgetMet: afterTokens <= policy.targetTokens,
    collapsed,
    selfCheck: check,
  }
}

/** 把压缩结果转成一条 Trace 事件 */
export function toCompactionEvent(turn: number, r: CompactionResult, recoverable: boolean): CompactionEvent {
  return {
    turn,
    applied: r.applied,
    reason: r.reason,
    triggerTokens: r.triggerTokens,
    beforeTokens: r.beforeTokens,
    afterTokens: r.afterTokens,
    savedTokens: r.savedTokens,
    budgetMet: r.budgetMet,
    recoverable,
    collapsedCount: r.collapsed.length,
    collapsed: r.collapsed,
  }
}

// ── 辅助 ────────────────────────────────────────────────────

export const PLACEHOLDER_PREFIX = '[上下文压缩]'

function makePlaceholder(c: { toolName: string; path: string | null }, chars: number, recoverable: boolean): string {
  const head = `${PLACEHOLDER_PREFIX} ${c.toolName} 的结果已折叠（原 ${chars} 字符）。`
  if (!recoverable) return `${head}内容不可恢复，请勿引用其具体数值。`
  const where = c.path ? `重新调用 ${c.toolName}(path="${c.path}")` : `重新调用 ${c.toolName}`
  return `${head}原文未删除，需要精确内容时请${where}取回。`
}

function extractPath(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null
  const p = (input as Record<string, unknown>).path
  return typeof p === 'string' && p.length > 0 ? p : null
}

export function totalTokens(messages: Message[]): number {
  return messages.reduce((sum, m) => sum + estimateTokens(m), 0)
}

/** 统计历史里已被折叠的条数，给 /compact 状态用 */
export function countPlaceholders(messages: Message[]): number {
  let n = 0
  for (const m of messages) {
    if (m.type !== 'user' || !Array.isArray(m.message.content)) continue
    for (const b of m.message.content) {
      if (b.type === 'tool_result' && typeof b.content === 'string' && b.content.startsWith(PLACEHOLDER_PREFIX)) {
        n += 1
      }
    }
  }
  return n
}
