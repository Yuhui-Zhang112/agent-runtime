/**
 * 消息类型系统
 *
 * 这份文件在参考源码（Claude Code 快照）中是缺失的，此处依据 30+ 处消费点
 * （构造、switch 分发、类型谓词）逆向重建。它是整个 runtime 的地基：
 * 主循环、工具系统、转录持久化、上下文压缩全部依赖这里的定义。
 *
 * 设计要点（对齐源码）：
 *  1. 每条消息带 uuid + parentUuid，构成一棵消息树 —— 子 agent / 后台任务的
 *     分支（sidechain）就是靠 parentUuid 挂在主干上的。
 *  2. 内部表示与 provider 解耦：这里是 provider 无关的中立结构，
 *     由 api/ 层负责把 Anthropic / OpenAI 的格式翻译过来。
 *  3. AssistantMessage 完整保留 usage —— 成本追踪、压缩阈值判定都靠它。
 */

/** 内容块：一条消息可以由多个块组成（文本 + 思考 + 工具调用混排） */
export type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'thinking'; thinking: string; signature?: string }
  | { type: 'redacted_thinking'; data: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }
  | {
      type: 'tool_result'
      tool_use_id: string
      content: string | ContentBlock[]
      is_error?: boolean
    }
  | {
      type: 'image'
      source: { type: 'base64'; media_type: string; data: string }
    }

/** token 用量 —— 成本追踪与压缩判定的唯一数据源 */
export interface Usage {
  input_tokens: number
  output_tokens: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface BaseMessage {
  uuid: string
  parentUuid: string | null
}

/** 用户消息。content 为字符串时是普通输入，为数组时可夹带 tool_result / 图片 */
export interface UserMessage extends BaseMessage {
  type: 'user'
  message: { role: 'user'; content: string | ContentBlock[] }
  /** 元数据类消息（如命令回显、压缩摘要）不计入真实对话 */
  isMeta?: boolean
  /** 压缩摘要标记 —— getMessagesAfterCompactBoundary 靠它切分历史 */
  isCompactSummary?: boolean
}

/** 助手消息。message 结构与 API 返回保持一致，便于直接回放 */
export interface AssistantMessage extends BaseMessage {
  type: 'assistant'
  message: {
    role: 'assistant'
    content: ContentBlock[]
    model: string
    stop_reason: string | null
    usage?: Usage
  }
  /** 本轮耗时（ms）与成本（USD）—— Trace 的关键字段 */
  durationMs?: number
  costUSD?: number
}

/** 系统注入消息，如压缩边界、hook 结果、任务通知 */
export interface SystemMessage extends BaseMessage {
  type: 'system'
  subtype: SystemMessageSubtype
  content: string
}

export type SystemMessageSubtype =
  | 'compact_boundary'
  | 'hook_result'
  | 'task_notification'
  | 'init'
  | 'local_command'

/** 工具执行过程中的流式进度（不计入发给模型的消息历史） */
export interface ProgressMessage extends BaseMessage {
  type: 'progress'
  toolUseID: string
  content: string
}

/** 上下文附件：文件内容、skill、plan 等，在压缩后用于恢复上下文 */
export interface AttachmentMessage extends BaseMessage {
  type: 'attachment'
  attachments: Array<{ name: string; content: string; tokenCount?: number }>
}

export type Message =
  | UserMessage
  | AssistantMessage
  | SystemMessage
  | ProgressMessage
  | AttachmentMessage

// ── 构造函数 ────────────────────────────────────────────────

let uuidCounter = 0
export function createUuid(): string {
  uuidCounter += 1
  return `${Date.now().toString(36)}-${uuidCounter.toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 8)}`
}

export function createUserMessage(
  content: string | ContentBlock[],
  parentUuid: string | null = null,
  opts: { isMeta?: boolean; isCompactSummary?: boolean } = {},
): UserMessage {
  return {
    type: 'user',
    uuid: createUuid(),
    parentUuid,
    message: { role: 'user', content },
    ...opts,
  }
}

export function createAssistantMessage(
  content: ContentBlock[],
  parentUuid: string | null = null,
  meta: { model: string; stopReason?: string | null; usage?: Usage; durationMs?: number } = {
    model: 'unknown',
  },
): AssistantMessage {
  return {
    type: 'assistant',
    uuid: createUuid(),
    parentUuid,
    message: {
      role: 'assistant',
      content,
      model: meta.model,
      stop_reason: meta.stopReason ?? null,
      usage: meta.usage,
    },
    durationMs: meta.durationMs,
  }
}

export function createSystemMessage(
  subtype: SystemMessageSubtype,
  content: string,
  parentUuid: string | null = null,
): SystemMessage {
  return { type: 'system', uuid: createUuid(), parentUuid, subtype, content }
}

// ── 类型谓词 ────────────────────────────────────────────────

export const isUserMessage = (m: Message): m is UserMessage => m.type === 'user'
export const isAssistantMessage = (m: Message): m is AssistantMessage =>
  m.type === 'assistant'
export const isSystemMessage = (m: Message): m is SystemMessage => m.type === 'system'

/** 从 assistant 消息中摘出所有 tool_use 块 —— 主循环判断"是否还要继续"靠这个 */
export function extractToolUses(msg: AssistantMessage): Array<{
  id: string
  name: string
  input: unknown
}> {
  return msg.message.content
    .filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use')
    .map((b) => ({ id: b.id, name: b.name, input: b.input }))
}

/**
 * 找出所有「有 tool_use 却没有配对 tool_result」的孤儿 id。
 *
 * 这是整个项目最重要的一条不变量：少一个结果，下次请求 API 直接 400，
 * 会话永久死锁。主循环、压缩自检、冒烟测试必须用同一份实现，
 * 不能各写一套 —— 否则「自检通过了但主循环不认」是最难查的一类 bug。
 */
export function findOrphanToolUseIds(messages: Message[]): string[] {
  const pending = new Set<string>()
  const answered = new Set<string>()

  for (const m of messages) {
    if (m.type === 'assistant') {
      for (const b of m.message.content) {
        if (b.type === 'tool_use') pending.add(b.id)
      }
    } else if (m.type === 'user' && Array.isArray(m.message.content)) {
      for (const b of m.message.content) {
        if (b.type === 'tool_result') answered.add(b.tool_use_id)
      }
    }
  }
  for (const id of answered) pending.delete(id)
  return [...pending]
}

/** 估算一条消息的 token 数（粗略：中文按 1 token/字、英文按 4 字符/token） */
export function estimateTokens(msg: Message): number {
  const text =
    msg.type === 'user'
      ? typeof msg.message.content === 'string'
        ? msg.message.content
        : JSON.stringify(msg.message.content)
      : msg.type === 'assistant'
        ? JSON.stringify(msg.message.content)
        : msg.type === 'system'
          ? msg.content
          : ''
  const cjk = (text.match(/[\u4e00-\u9fa5]/g) ?? []).length
  return Math.ceil(cjk + (text.length - cjk) / 4)
}
