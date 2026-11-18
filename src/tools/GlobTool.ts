/**
 * GlobTool —— 按通配符找文件
 *
 * 只读、可并发。模型想了解一个陌生项目时，第一个调用的就是它。
 *
 * 为什么不让模型直接列目录：真实项目里 node_modules 动辄几万个文件，
 * 全列出来会把上下文撑爆。所以这里做三件事：
 *   1. 跳过依赖与构建产物目录
 *   2. 结果数量封顶
 *   3. 按修改时间倒序（最近动过的文件通常最相关）
 */

import { statSync } from 'node:fs'
import { relative, resolve, sep } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolContext } from '../core/tool.js'
import { resolveInCwd, walkFiles } from './paths.js'

const MAX_RESULTS = 200

export const GlobTool = defineTool({
  name: 'Glob',
  risk: 'read',
  description:
    '按通配符模式查找文件路径，返回匹配的文件列表。\n' +
    '模式示例：`**/*.ts` 所有 ts 文件；`src/**/*.ts` src 下的 ts；`*.json` 根目录下的 json。\n' +
    '注意：只会返回文件，不含目录；已自动跳过 node_modules 等依赖目录。',
  inputSchema: z.object({
    pattern: z.string().min(1).describe('通配符模式，如 src/**/*.ts'),
    path: z.string().optional().describe('从哪个目录开始找，默认当前目录'),
  }),

  isReadOnly: true,
  isConcurrencySafe: true,

  async call(input: { pattern: string; path?: string }, ctx: ToolContext) {
    const root = input.path
      ? (() => {
          const r = resolveInCwd(ctx.cwd, input.path)
          return r.ok ? r.abs : null
        })()
      : ctx.cwd
    if (!root) return { output: `目录越界：${input.path}`, isError: true }

    const base = baseDirOf(input.pattern, root)
    const re = globToRegExp(normalizePattern(input.pattern))
    const cwd = ctx.cwd

    const files = walkFiles(base)
      .filter((abs) => re.test(toPosix(relative(cwd, abs))))
      // mtime 相同时（CI 刚 checkout、或同一毫秒内批量创建）必须用路径兜底，
      // 否则顺序会退回文件系统目录项顺序，离线评测的 token/成本无法跨机器复现。
      .sort((a, b) => mtime(b) - mtime(a) || (a < b ? -1 : a > b ? 1 : 0))
      .slice(0, MAX_RESULTS)
      .map((abs) => toPosix(relative(cwd, abs)))

    if (files.length === 0) return { output: `没有匹配 ${input.pattern} 的文件` }
    return {
      output:
        `找到 ${files.length} 个文件${files.length === MAX_RESULTS ? '（已封顶）' : ''}：\n` +
        files.join('\n'),
    }
  },
})

// ── 内部实现 ────────────────────────────────────────────────

/** 取模式中不含通配符的前缀作为起始目录，避免全盘扫描 */
function baseDirOf(pattern: string, root: string): string {
  const parts = normalizePattern(pattern).split('/')
  const base: string[] = []
  for (const p of parts) {
    if (/[*?[\]]/.test(p)) break
    base.push(p)
  }
  const b = base.join('/')
  return b ? resolve(root, b) : root
}

function normalizePattern(p: string): string {
  return p.replace(/\\/g, '/').replace(/^\.\//, '')
}

const toPosix = (p: string): string => p.split(sep).join('/')

/** 极简 glob → 正则。够用且不引第三方依赖 */
function globToRegExp(pattern: string): RegExp {
  let re = ''
  for (let i = 0; i < pattern.length; i += 1) {
    const c = pattern[i]!
    if (c === '*') {
      if (pattern[i + 1] === '*') {
        if (pattern[i + 2] === '/') {
          re += '(?:.*/)?'
          i += 2
        } else {
          re += '.*'
          i += 1
        }
      } else {
        re += '[^/]*'
      }
    } else if (c === '?') {
      re += '[^/]'
    } else if ('.+^${}()|[]\\'.includes(c)) {
      re += '\\' + c
    } else {
      re += c
    }
  }
  return new RegExp(`^${re}$`)
}

function mtime(abs: string): number {
  try {
    return statSync(abs).mtimeMs
  } catch {
    return 0
  }
}
