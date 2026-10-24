/**
 * EditTool —— 修改已有文件
 *
 * 做法不是"重写整个文件"，而是**精确替换一段字符串**。
 * 这是参考源码 FileEditTool 的核心思路，理由很实在：
 *
 *   1. 省 token：改一行不需要把整个文件重新发一遍
 *   2. 更安全：模型没法顺手把没让它改的地方改掉
 *   3. 可验证：找不到原字符串就直接报错，不会静默写坏文件
 *
 * 唯一性要求：oldString 必须在文件里只出现一次。
 * 出现多次就报错，逼模型多带一点上下文把位置写精确 ——
 * 否则它会改错地方，而且你还看不出来。
 */

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { defineTool, type ToolContext } from '../core/tool.js'
import { resolveInCwd } from './paths.js'

export const EditTool = defineTool({
  name: 'Edit',
  description:
    '把文件中的一段字符串替换成另一段。\n' +
    'oldString 必须在文件中**唯一**（或显式传 replaceAll）。\n' +
    '建议多带一点上下文以提高唯一性，比如包含前后几行。',
  inputSchema: z.object({
    path: z.string().min(1).describe('要修改的文件路径'),
    oldString: z.string().min(1).describe('要被替换掉的原文，必须原样匹配（含缩进）'),
    newString: z.string().describe('替换后的内容'),
    replaceAll: z.boolean().optional().describe('是否替换全部出现位置，默认 false'),
  }),

  async call(
    input: { path: string; oldString: string; newString: string; replaceAll?: boolean },
    ctx: ToolContext,
  ) {
    const safe = resolveInCwd(ctx.cwd, input.path)
    if (!safe.ok) return { output: safe.error, isError: true }

    if (!existsSync(safe.abs)) {
      return { output: `文件不存在，无法编辑：${input.path}\n如果是新建文件，请用 Write。`, isError: true }
    }

    const original = readFileSync(safe.abs, 'utf8')
    const count = countOccurrences(original, input.oldString)

    if (count === 0) {
      return {
        output: `没有找到要替换的内容：\n${indent(input.oldString)}\n` +
          `请确认原文完全一致（包括空格与缩进）。`,
        isError: true,
      }
    }
    if (count > 1 && !input.replaceAll) {
      return {
        output:
          `oldString 在文件中出现了 ${count} 次，无法确定改哪一处。\n` +
          `请补充更多上下文让它唯一，或传 replaceAll: true 替换全部。`,
        isError: true,
      }
    }

    const updated = input.replaceAll
      ? original.split(input.oldString).join(input.newString)
      : original.replace(input.oldString, input.newString)

    writeFileSync(safe.abs, updated, 'utf8')

    const beforeLines = input.oldString.split('\n').length
    const afterLines = input.newString.split('\n').length
    return {
      output:
        `已修改 ${input.path}\n` +
        `- 删去 ${beforeLines} 行\n+ 新增 ${afterLines} 行\n` +
        `替换了 ${input.replaceAll ? count : 1} 处`,
    }
  },
})

function countOccurrences(haystack: string, needle: string): number {
  if (!needle) return 0
  let n = 0
  let i = 0
  while (true) {
    const at = haystack.indexOf(needle, i)
    if (at === -1) break
    n += 1
    i = at + needle.length
  }
  return n
}

const indent = (s: string): string =>
  s
    .split('\n')
    .map((l) => `    ${l}`)
    .join('\n')
