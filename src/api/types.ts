/**
 * Provider 抽象层
 *
 * 关键设计（对齐参考源码）：所有 provider 的流事件统一成 Anthropic 的形状，
 * 由 callModel 单点消费。这样新增一个 provider 只需写"翻译器"，
 * 主循环 / Trace / Eval 完全不用改 —— 这是后面做「异构后端对比评测」的地基。
 */

import type { ContentBlock, Message, Usage } from '../types/message.js'

export interface ToolSpec {
  name: string
  description: string
  /** JSON Schema，由 zod 的 zodToJsonSchema 生成（Phase 1 接入） */
  input_schema: Record<string, unknown>
}

export interface ModelRequest {
  model: string
  system: string
  messages: Message[]
  tools: ToolSpec[]
  maxTokens: number
  signal?: AbortSignal
  /** 透传给 provider 的额外参数（如 temperature） */
  temperature?: number
}

// ── 统一流事件（对齐 Anthropic 语义） ────────────────────────

export type StreamDelta =
  | { type: 'text_delta'; text: string }
  | { type: 'thinking_delta'; thinking: string }
  | { type: 'input_json_delta'; partial_json: string }

export type StreamEvent =
  | { type: 'message_start'; usage?: Usage }
  | { type: 'content_block_start'; index: number; block: Partial<ContentBlock> }
  | { type: 'content_block_delta'; index: number; delta: StreamDelta }
  | { type: 'content_block_stop'; index: number }
  | {
      type: 'message_delta'
      usage?: Partial<Usage>
      stopReason?: string | null
    }
  | { type: 'message_stop' }
  | { type: 'error'; error: Error }

export interface ModelProvider {
  readonly name: string
  stream(req: ModelRequest): AsyncGenerator<StreamEvent>
}

// ── 内部消息 → provider 消息 ────────────────────────────────

/** 过滤掉不发给模型的消息类型（progress / system / attachment） */
export function toAPIMessages(messages: Message[]): Message[] {
  return messages.filter(
    (m) => m.type === 'user' || m.type === 'assistant',
  )
}

/** 把 ContentBlock 转成 Anthropic 的 BlockParam；未知类型安全降级为文本 */
export function toBlockParam(block: ContentBlock): Record<string, unknown> {
  switch (block.type) {
    case 'text':
      return { type: 'text', text: block.text }
    case 'thinking':
      return block.signature
        ? { type: 'thinking', thinking: block.thinking, signature: block.signature }
        : { type: 'thinking', thinking: block.thinking }
    case 'redacted_thinking':
      return { type: 'redacted_thinking', data: block.data }
    case 'tool_use':
      return { type: 'tool_use', id: block.id, name: block.name, input: block.input }
    case 'tool_result':
      return {
        type: 'tool_result',
        tool_use_id: block.tool_use_id,
        content: block.content,
        ...(block.is_error ? { is_error: true } : {}),
      }
    case 'image':
      return { type: 'image', source: block.source }
    default:
      return { type: 'text', text: '' }
  }
}

/** 值得重试的 HTTP 状态码（服务端临时故障） */
export const RETRYABLE_STATUS = new Set([
  408, // Request Timeout
  409, // Conflict（多为并发写冲突，重试通常能过）
  429, // Too Many Requests —— 限流，最常见的重试原因
  500, 502, 503, 504, // 服务端错误与网关问题
  522, 524, // Cloudflare 超时类
  529, // Anthropic overloaded_error
])

export function statusIsRetryable(status?: number): boolean {
  return status !== undefined && RETRYABLE_STATUS.has(status)
}

/**
 * provider 抛出的错误。
 * status 与 retryable 是重试策略的唯一判据 —— 各 provider 负责把自家 SDK
 * 的错误翻译成这个形状，重试逻辑就不需要认识任何一家厂商的错误类型。
 *
 * retryable 不显式给时**按 status 自动推导**。这不是偷懒，是防呆：
 * 否则 `new ProviderError('限流', 429)` 会因为默认 false 而被判成不可重试，
 * 于是重试机制看起来存在、实际一次都不触发 —— 这种 bug 极难发现。
 */
export class ProviderError extends Error {
  readonly status?: number
  readonly retryable: boolean
  /** 服务端建议的重试等待（来自 Retry-After 头）。有它就用它，比自己算的准 */
  readonly retryAfterMs?: number

  constructor(message: string, status?: number, retryable?: boolean, retryAfterMs?: number) {
    super(message)
    this.name = 'ProviderError'
    this.status = status
    this.retryable = retryable ?? statusIsRetryable(status)
    this.retryAfterMs = retryAfterMs
  }
}
