/**
 * WriteTool —— 新建文件
 *
 * 与 Edit 的分工（对齐参考源码）：
 *   Write = 凭空创建；Edit = 修改已有内容。
 *   所以这里**拒绝覆盖已存在的文件**——那属于 Edit 的活。
 *
 * 为什么这么严格：覆盖是最危险的操作。模型以为自己在新建，
 * 实际上把用户已有的文件清空了，这种事故无法撤销（没进 git 的话）。
 * 宁可让它报错，然后模型自己会改用 Edit。
 */

import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolContext } from '../core/tool.js'
import { resolveInCwd } from './paths.js'

export const WriteTool = defineTool({
  name: 'Write',
  description:
    '创建一个新文件并写入内容。\n' +
    '重要：只能用于【新建】。修改已存在的文件请用 Edit。\n' +
    '会自动创建缺失的父目录。',
  inputSchema: z.object({
    path: z.string().min(1).describe('要创建的文件路径'),
    content: z.string().describe('文件完整内容'),
  }),

  // 不声明 isReadOnly / isConcurrencySafe —— 保持默认的 false（会改文件、串行执行）

  async call(input: { path: string; content: string }, ctx: ToolContext) {
    const safe = resolveInCwd(ctx.cwd, input.path)
    if (!safe.ok) return { output: safe.error, isError: true }

    if (existsSync(safe.abs)) {
      return {
        output: `文件已存在，拒绝覆盖：${input.path}\n如果要修改它，请改用 Edit 工具。`,
        isError: true,
      }
    }

    try {
      mkdirSync(dirname(safe.abs), { recursive: true })
      writeFileSync(safe.abs, input.content, 'utf8')
    } catch (err) {
      return { output: `写入失败：${err instanceof Error ? err.message : String(err)}`, isError: true }
    }

    return {
      output: `已创建 ${input.path}（${Buffer.byteLength(input.content, 'utf8')} 字节，${input.content.split('\n').length} 行）`,
    }
  },
})
