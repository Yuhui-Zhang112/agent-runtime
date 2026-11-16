/**
 * GrepTool —— 按内容搜索
 *
 * 只读、可并发。模型找"这个函数在哪被用到"时用的就是它。
 *
 * 三个必须做对的点：
 *  1. 正则非法要返回 isError，不能崩 —— 模型写的正则经常不合法
 *  2. 命中数必须封顶 —— 一个 `.*` 就能搜出几万行，直接撑爆上下文
 *  3. 跳过超大文件和二进制 —— 读 1GB 的日志会把内存吃光
 */

import { readFileSync, statSync } from 'node:fs'
import { relative, sep } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolContext } from '../core/tool.js'
import { resolveInCwd, walkFiles } from './paths.js'

const MAX_FILE_BYTES = 1024 * 1024
const DEFAULT_MAX_MATCHES = 50

export const GrepTool = defineTool({
  name: 'Grep',
  risk: 'read',
  description:
    '在文件内容中搜索，返回 `路径:行号: 内容` 形式的命中列表。\n' +
    'pattern 是正则（如 `function\\s+runAgent`）。用 include 限定文件类型以加快速度。',
  inputSchema: z.object({
    pattern: z.string().min(1).describe('正则表达式'),
    path: z.string().optional().describe('在哪个目录/文件里搜，默认当前目录'),
    include: z.string().optional().describe('只搜匹配该模式的文件，如 *.ts'),
    caseSensitive: z.boolean().optional().describe('是否区分大小写，默认 false'),
    maxMatches: z.number().int().min(1).max(500).optional().describe('最多返回多少条，默认 50'),
  }),

  isReadOnly: true,
  isConcurrencySafe: true,

  async call(
    input: {
      pattern: string
      path?: string
      include?: string
      caseSensitive?: boolean
      maxMatches?: number
    },
    ctx: ToolContext,
  ) {
    let re: RegExp
    try {
      re = new RegExp(input.pattern, input.caseSensitive ? '' : 'i')
    } catch (err) {
      return {
        output: `正则表达式不合法：${input.pattern}\n${err instanceof Error ? err.message : ''}`,
        isError: true,
      }
    }

    const rootRes = resolveInCwd(ctx.cwd, input.path ?? '.')
    if (!rootRes.ok) return { output: rootRes.error, isError: true }

    const max = input.maxMatches ?? DEFAULT_MAX_MATCHES
    const includeRe = input.include ? simpleIncludeToRegExp(input.include) : null

    const candidates = walkFiles(rootRes.abs).filter((abs) => {
      if (!includeRe) return true
      return includeRe.test(abs.split(sep).pop() ?? '')
    })

    const hits: string[] = []
    let truncated = false

    for (const abs of candidates) {
      if (hits.length >= max) {
        truncated = true
        break
      }
      let size: number
      try {
        size = statSync(abs).size
      } catch {
        continue
      }
      if (size > MAX_FILE_BYTES) continue

      let text: string
      try {
        text = readFileSync(abs, 'utf8')
      } catch {
        continue // 二进制或读不了，跳过
      }

      const rel = relative(ctx.cwd, abs).split(sep).join('/')
      text.split('\n').forEach((line, i) => {
        if (hits.length >= max) return
        if (re.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 200)}`)
      })
    }

    if (hits.length === 0) return { output: `没有找到匹配 ${input.pattern} 的内容` }
    return {
      output:
        `${hits.length} 条命中${truncated ? '（已封顶，请缩小范围）' : ''}：\n` + hits.join('\n'),
    }
  },
})

/** include 只支持最简单的 `*.ts` / `*.md` 形式 */
function simpleIncludeToRegExp(include: string): RegExp {
  const escaped = include.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')
  return new RegExp(`^${escaped}$`)
}
