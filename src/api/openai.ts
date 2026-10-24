/**
 * OpenAI 兼容 provider（DeepSeek / 通义 / 智谱 / Moonshot / vLLM / Ollama 等）
 *
 * 存在的意义不只是"多支持几家"：它让「把同一批任务分别跑在 Claude 和本地小模型上，
 * 对比 tool-calling 成功率」这个 Eval 实验变得可行。用原生 fetch + SSE 手写解析，
 * 不引 SDK —— 也顺带把流式协议搞透了。
 *
 * 职责：把 OpenAI 的 delta 流翻译成统一的 Anthropic 形状。
 * 难点在于 OpenAI 的 tool_calls 是增量拼接（id / name / arguments 分批到达），
 * 而 Anthropic 的语义是 content_block_start → delta → stop，需要做块状态机。
 */

import type { AssistantMessage, UserMessage } from '../types/message.js'
import { ProviderError, type ModelProvider, type ModelRequest, type StreamEvent, type StreamDelta } from './types.js'
import { parseRetryAfter, statusIsRetryable, toProviderError } from './errors.js'

interface OpenAIToolCall {
  index: number
  id?: string
  function?: { name?: string; arguments?: string }
}

interface OpenAIChunk {
  choices?: Array<{
    index: number
    delta?: { content?: string; tool_calls?: OpenAIToolCall[] }
    finish_reason?: string | null
  }>
  usage?: {
    prompt_tokens?: number
    completion_tokens?: number
    prompt_tokens_details?: { cached_tokens?: number }
  }
}

type OMessage =
  | ReturnType<typeof toOpenAIUser>
  | ReturnType<typeof toOpenAIAssistant>

export class OpenAICompatProvider implements ModelProvider {
  readonly name = 'openai-compat'
  constructor(
    private apiKey: string,
    private baseURL = 'https://api.openai.com/v1',
  ) {}

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    // 只发送 user / assistant；system / progress / attachment 不进 API 消息数组
    const messages: OMessage[] = req.messages.flatMap((m): OMessage[] => {
      if (m.type === 'user') return [toOpenAIUser(m)]
      if (m.type === 'assistant') return [toOpenAIAssistant(m)]
      return []
    })

    const body: Record<string, unknown> = {
      model: req.model,
      messages,
      stream: true,
      stream_options: { include_usage: true },
      max_tokens: req.maxTokens,
    }
    if (req.tools.length > 0) {
      body.tools = req.tools.map((t) => ({
        type: 'function',
        function: { name: t.name, description: t.description, parameters: t.input_schema },
      }))
    }
    if (req.temperature !== undefined) body.temperature = req.temperature

    const res = await fetch(`${this.baseURL.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
      ...(req.signal ? { signal: req.signal } : {}),
    }).catch((err: unknown) => {
      // fetch 只在"连都没连上"时 reject（DNS 失败、连接重置）。
      // 必须翻译成 ProviderError，否则重试逻辑只能靠猜错误消息
      throw toProviderError(err)
    })

    if (!res.ok || !res.body) {
      throw new ProviderError(
        `OpenAI 兼容接口返回 ${res.status}`,
        res.status,
        statusIsRetryable(res.status),
        parseRetryAfter(res.headers.get('retry-after')),
      )
    }

    // ── 块状态机 ──────────────────────────────────────────
    let nextIndex = 0
    let textIndex: number | null = null
    const toolIndex = new Map<number, number>()
    const toolArgs = new Map<number, string>()

    yield { type: 'message_start' }

    // 流已经开出去了才开始报错（读到一半断线）也要翻译。
    // 这种情况由 parseSSE 内部兜住并转成 ProviderError：
    // callModel 会丢弃已收到的快照，所以整轮重试是安全的
    for await (const chunk of parseSSE(res.body)) {
      const choice = chunk.choices?.[0]

      if (choice?.delta?.content) {
        if (textIndex === null) {
          textIndex = nextIndex++
          yield { type: 'content_block_start', index: textIndex, block: { type: 'text', text: '' } }
        }
        yield {
          type: 'content_block_delta',
          index: textIndex,
          delta: { type: 'text_delta', text: choice.delta.content },
        }
      }

      for (const tc of choice?.delta?.tool_calls ?? []) {
        if (!toolIndex.has(tc.index) && tc.id) {
          const idx = nextIndex++
          toolIndex.set(tc.index, idx)
          toolArgs.set(tc.index, '')
          yield {
            type: 'content_block_start',
            index: idx,
            block: { type: 'tool_use', id: tc.id, name: tc.function?.name ?? '', input: {} },
          }
        }
        if (tc.function?.arguments) {
          const idx = toolIndex.get(tc.index)
          if (idx !== undefined) {
            toolArgs.set(tc.index, (toolArgs.get(tc.index) ?? '') + tc.function.arguments)
            yield {
              type: 'content_block_delta',
              index: idx,
              delta: { type: 'input_json_delta', partial_json: tc.function.arguments },
            }
          }
        }
      }

      if (choice?.finish_reason) {
        if (textIndex !== null) {
          yield { type: 'content_block_stop', index: textIndex }
          textIndex = null
        }
        for (const idx of toolIndex.values()) yield { type: 'content_block_stop', index: idx }
        toolIndex.clear()

        yield {
          type: 'message_delta',
          stopReason: mapFinishReason(choice.finish_reason),
        }
      }

      if (chunk.usage) {
        yield {
          type: 'message_delta',
          usage: {
            input_tokens: chunk.usage.prompt_tokens ?? 0,
            output_tokens: chunk.usage.completion_tokens ?? 0,
            cache_read_input_tokens: chunk.usage.prompt_tokens_details?.cached_tokens ?? 0,
          },
        }
      }
    }

    yield { type: 'message_stop' }
  }
}

function mapFinishReason(reason: string): string {
  switch (reason) {
    case 'tool_calls':
      return 'tool_use'
    case 'length':
      return 'max_tokens'
    default:
      return 'end_turn'
  }
}

/** 解析 SSE：按空行切分事件，取 data: 行，遇 [DONE] 结束 */
async function* parseSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<OpenAIChunk> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  try {
    while (true) {
      // 读到一半断线会在这里抛。转成 ProviderError（网络层，可重试）
      const { done, value } = await reader.read().catch((err: unknown) => {
        throw toProviderError(err)
      })
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      let sep: number
      while ((sep = buffer.indexOf('\n\n')) !== -1) {
        const raw = buffer.slice(0, sep)
        buffer = buffer.slice(sep + 2)
        const dataLine = raw.split('\n').find((l) => l.startsWith('data:'))
        if (!dataLine) continue
        const payload = dataLine.slice(5).trim()
        if (payload === '[DONE]') return
        try {
          yield JSON.parse(payload) as OpenAIChunk
        } catch {
          // 忽略半包 / 心跳
        }
      }
    }
  } finally {
    reader.releaseLock()
  }
}

function toOpenAIUser(m: UserMessage) {
  if (typeof m.message.content === 'string') {
    return { role: 'user' as const, content: m.message.content }
  }
  const parts = m.message.content.map((b) => {
    if (b.type === 'text') return { type: 'text' as const, text: b.text }
    if (b.type === 'tool_result') {
      return {
        type: 'text' as const,
        text: `[tool_result ${b.tool_use_id}]\n${
          typeof b.content === 'string' ? b.content : JSON.stringify(b.content)
        }`,
      }
    }
    return { type: 'text' as const, text: '' }
  })
  return { role: 'user' as const, content: parts }
}

function toOpenAIAssistant(m: AssistantMessage) {
  const text = m.message.content
    .filter((b) => b.type === 'text')
    .map((b) => (b.type === 'text' ? b.text : ''))
    .join('')

  const toolCalls = m.message.content
    .filter((b) => b.type === 'tool_use')
    .map((b) => ({
      id: b.type === 'tool_use' ? b.id : '',
      type: 'function' as const,
      function: {
        name: b.type === 'tool_use' ? b.name : '',
        arguments: JSON.stringify(b.type === 'tool_use' ? b.input : {}),
      },
    }))

  return {
    role: 'assistant' as const,
    content: text || null,
    ...(toolCalls.length > 0 ? { tool_calls: toolCalls } : {}),
  }
}
