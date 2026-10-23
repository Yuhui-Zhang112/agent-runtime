/**
 * Anthropic provider
 *
 * 之所以把 Anthropic 放在第一位：它是参考源码的原生目标，
 * prompt cache（cache_control）、thinking block 这些高级特性只有这条路能完整验证。
 */

import Anthropic from '@anthropic-ai/sdk'
import type { Usage } from '../types/message.js'
import { toBlockParam, type ModelProvider, type ModelRequest, type StreamEvent } from './types.js'

type MsgParam = Anthropic.MessageParam

export class AnthropicProvider implements ModelProvider {
  readonly name = 'anthropic'
  private client: Anthropic

  constructor(apiKey: string, baseURL?: string) {
    this.client = new Anthropic({ apiKey, ...(baseURL ? { baseURL } : {}) })
  }

  async *stream(req: ModelRequest): AsyncGenerator<StreamEvent> {
    // 只发送 user / assistant；system / progress / attachment 不进 API 消息数组
    const messages: MsgParam[] = req.messages.flatMap((m): MsgParam[] => {
      const blocks = (content: Parameters<typeof toBlockParam>[0][]) =>
        content.map(toBlockParam) as unknown as Anthropic.ContentBlockParam[]

      if (m.type === 'user') {
        return [
          {
            role: 'user',
            content:
              typeof m.message.content === 'string'
                ? m.message.content
                : blocks(m.message.content),
          },
        ]
      }
      if (m.type === 'assistant') {
        return [{ role: 'assistant', content: blocks(m.message.content) }]
      }
      return []
    })

    const tools: Anthropic.Tool[] = req.tools.map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.input_schema as Anthropic.Tool.InputSchema,
    }))

    // stream: true 必须放在 body 里，SDK 才会返回 Stream；
    // APIPromise 是 thenable，await 之后才能异步迭代
    const stream = await this.client.messages.create(
      {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.system,
        messages,
        stream: true,
        ...(tools.length > 0 ? { tools } : {}),
        ...(req.temperature !== undefined ? { temperature: req.temperature } : {}),
      },
      req.signal ? { signal: req.signal } : {},
    )

    for await (const event of stream) {
      const translated = translate(event)
      if (translated) yield translated
    }
  }
}

function translate(event: Anthropic.MessageStreamEvent): StreamEvent | null {
  switch (event.type) {
    case 'message_start':
      return { type: 'message_start', usage: event.message.usage as Usage }

    case 'content_block_start':
      return {
        type: 'content_block_start',
        index: event.index,
        block: event.content_block as never,
      }

    case 'content_block_delta':
      return {
        type: 'content_block_delta',
        index: event.index,
        delta: event.delta as never,
      }

    case 'content_block_stop':
      return { type: 'content_block_stop', index: event.index }

    case 'message_delta':
      return {
        type: 'message_delta',
        usage: event.usage as Partial<Usage> | undefined,
        stopReason: event.delta.stop_reason ?? null,
      }

    case 'message_stop':
      return { type: 'message_stop' }

    default: {
      // 部分 SDK 版本在联合类型里没有声明 error 事件，这里做兜底
      const e = event as { type?: string; error?: unknown }
      if (e.type === 'error') {
        return { type: 'error', error: new Error(JSON.stringify(e.error)) }
      }
      return null
    }
  }
}
