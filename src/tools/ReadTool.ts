/**
 * ReadTool —— 第一个工具，也是最简单的工具
 *
 * 它演示了一个只读工具的全部套路：
 *   1. 用 zod 声明参数（同时用于校验 + 生成给模型看的 JSON Schema）
 *   2. 显式声明 isReadOnly / isConcurrencySafe = true（敢并发、无副作用）
 *   3. 执行时把结果格式化成"对模型友好"的文本（带行号，方便模型引用）
 *   4. 出错就返回 isError 结果，不抛异常
 */

import { readFileSync, statSync } from 'node:fs'
import { resolve } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolContext } from '../core/tool.js'

/** 单次读取上限，防止一个巨型文件把上下文撑爆（上下文工程的第一道防线） */
const MAX_BYTES = 100_000

export const ReadTool = defineTool({
  name: 'Read',
  description:
    '读取文件内容并返回带行号的文本。用于查看源代码、配置、文档。' +
    '默认读整个文件，可用 offset/limit 分段读取大文件。',
  inputSchema: z.object({
    path: z.string().min(1).describe('文件路径，可相对当前目录'),
    offset: z.number().int().min(0).optional().describe('从第几行开始读（0 起算）'),
    limit: z.number().int().min(1).optional().describe('最多读多少行'),
  }),

  isReadOnly: true,
  isConcurrencySafe: true,

  async call(
    input: { path: string; offset?: number; limit?: number },
    ctx: ToolContext,
  ) {
    const abs = resolve(ctx.cwd, input.path)

    let size: number
    try {
      size = statSync(abs).size
    } catch {
      return { output: `文件不存在或无法访问：${abs}`, isError: true }
    }

    const raw = readFileSync(abs, 'utf8')
    const body = raw.length > MAX_BYTES ? raw.slice(0, MAX_BYTES) : raw

    const lines = body.split('\n')
    const start = input.offset ?? 0
    const end = input.limit === undefined ? lines.length : start + input.limit
    const slice = lines.slice(start, end)

    const numbered = slice
      .map((line, i) => `${String(start + i + 1).padStart(5, ' ')}\t${line}`)
      .join('\n')

    const truncated = raw.length > MAX_BYTES
    return {
      output:
        `${abs}${truncated ? `\n[注意：文件 ${(size / 1024).toFixed(1)}KB，已截断到 100KB]` : ''}\n` +
        numbered,
    }
  },
})
