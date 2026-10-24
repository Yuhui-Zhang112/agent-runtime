/**
 * 路径安全工具
 *
 * 读写类工具的第一道闸：任何路径都必须落在工作目录内。
 * 没有它，模型一句 `Write ../../.zshrc` 就能改到你系统的任何地方。
 *
 * 完整的权限系统（模式、规则匹配、用户批准）在 Phase 2，
 * 这里只做最基础也最关键的一条：不许越界。
 */

import { readdirSync } from 'node:fs'
import { isAbsolute, join, resolve, relative } from 'node:path'

export type SafePath = { ok: true; abs: string } | { ok: false; error: string }

/** 把用户/模型给的路径解析成绝对路径，并确保它没跑出 cwd */
export function resolveInCwd(cwd: string, p: string): SafePath {
  const abs = resolve(cwd, p)
  const rel = relative(cwd, abs)
  if (rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))) {
    return { ok: true, abs }
  }
  return { ok: false, error: `路径超出工作目录，已拒绝：${p}（解析为 ${abs}）` }
}

/** 遍历目录收集文件。跳过依赖目录与构建产物，避免搜出几十万条 */
export function walkFiles(root: string, limit = 5000): string[] {
  const SKIP = new Set([
    'node_modules',
    '.git',
    'dist',
    'build',
    'coverage',
    '.next',
    '.cache',
    '.workbuddy',
  ])
  const out: string[] = []

  const walk = (dir: string, depth: number): void => {
    if (out.length >= limit || depth > 20) return
    let entries
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return // 无权限等，静默跳过
    }
    for (const e of entries) {
      if (out.length >= limit) return
      if (SKIP.has(e.name)) continue
      const full = join(dir, e.name)
      if (e.isDirectory()) walk(full, depth + 1)
      else if (e.isFile()) out.push(full)
    }
  }

  walk(root, 0)
  return out
}
