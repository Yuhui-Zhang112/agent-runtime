/**
 * 冒烟测试：不依赖任何真实 API key
 *
 * 起一个本地假 SSE 服务端，模拟 OpenAI 兼容接口的流式响应
 * （文本分块 + tool_use 的 JSON 被拆成两截 + usage + finish_reason），
 * 端到端验证：SSE 解析 → 统一流事件 → callModel 块累积 → tool input 还原。
 *
 * 这一步通过，说明流式内核是通的；后面接真 provider 只是换 URL 和 key。
 *   npm run smoke
 */

import { createServer } from 'node:http'
import { OpenAICompatProvider } from '../api/openai.js'
import { callModel } from '../core/callModel.js'
import { createUserMessage, extractToolUses } from '../types/message.js'

const CHUNKS = [
  { choices: [{ index: 0, delta: { content: '我来读一下' } }] },
  { choices: [{ index: 0, delta: { content: '这个文件。' } }] },
  {
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [{ index: 0, id: 'tu_1', function: { name: 'Read', arguments: '' } }],
        },
      },
    ],
  },
  {
    choices: [
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '{"pa' } }] } },
    ],
  },
  {
    choices: [
      { index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: 'th":"a.ts"}' } }] } },
    ],
  },
  { choices: [{ index: 0, finish_reason: 'tool_calls' }] },
  { usage: { prompt_tokens: 1200, completion_tokens: 87, prompt_tokens_details: { cached_tokens: 900 } } },
]

function startFakeServer(): Promise<{ port: number; close: () => void }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      let body = ''
      req.on('data', (c) => (body += c))
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        })
        for (const c of CHUNKS) res.write(`data: ${JSON.stringify(c)}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
      })
    })
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      resolve({ port, close: () => server.close() })
    })
  })
}

async function main(): Promise<void> {
  const { port, close } = await startFakeServer()
  const provider = new OpenAICompatProvider('fake-key', `http://127.0.0.1:${port}/v1`)

  const messages = [createUserMessage('读一下 a.ts')]
  let final: Awaited<ReturnType<typeof callModel>> extends AsyncGenerator<infer T> ? T : never
  let snapshots = 0

  for await (const snap of callModel(
    provider,
    { model: 'fake-model', system: 'test', messages, tools: [], maxTokens: 1024 },
    { parentUuid: messages[0]!.uuid },
  )) {
    snapshots += 1
    final = snap
  }
  close()

  const content = final!.message.content
  const text = content.find((b) => b.type === 'text')
  const toolUses = extractToolUses(final!)

  const checks: Array<[string, boolean, string]> = [
    ['文本块正确拼接', text?.type === 'text' && text.text === '我来读一下这个文件。', text?.type === 'text' ? text.text : '(无)'],
    ['tool_use 块被识别', toolUses.length === 1, `${toolUses.length} 个`],
    ['tool 名称正确', toolUses[0]?.name === 'Read', toolUses[0]?.name ?? '(无)'],
    [
      '拆开的 JSON 被还原',
      JSON.stringify(toolUses[0]?.input) === '{"path":"a.ts"}',
      JSON.stringify(toolUses[0]?.input),
    ],
    ['stop_reason 映射正确', final!.message.stop_reason === 'tool_use', String(final!.message.stop_reason)],
    ['usage 被记录', final!.message.usage?.cache_read_input_tokens === 900, JSON.stringify(final!.message.usage)],
    ['快照增量产出', snapshots >= 2, `${snapshots} 个快照`],
  ]

  console.log('\n  冒烟测试 —— 流式内核\n')
  let failed = 0
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}  \x1b[2m${detail}\x1b[0m`)
    if (!ok) failed += 1
  }

  console.log(
    failed === 0
      ? '\n  \x1b[32m全部通过。流式内核可用，接真实 provider 只需换 URL 和 key。\x1b[0m\n'
      : `\n  \x1b[31m${failed} 项失败\x1b[0m\n`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
