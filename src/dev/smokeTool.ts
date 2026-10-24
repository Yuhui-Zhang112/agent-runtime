/**
 * 冒烟测试 · 工具系统（Phase 1 第 1 块）
 *
 * 不依赖网络。手工模拟「模型说：我要读 package.json」这一步，
 * 验证：工具注册 → 生成给模型看的 JSON Schema → 校验参数 → 执行 →
 * 包装成 tool_result 块 → 各类错误都被兜住且标成 isError。
 *
 *   npm run smoke:tool
 */

import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ReadTool } from '../tools/ReadTool.js'
import { GlobTool } from '../tools/GlobTool.js'
import { GrepTool } from '../tools/GrepTool.js'
import { WriteTool } from '../tools/WriteTool.js'
import { EditTool } from '../tools/EditTool.js'
import { ToolRegistry, defineTool, runTool, toToolSpec, type ToolContext } from '../core/tool.js'
import { z } from 'zod'
import type { ContentBlock } from '../types/message.js'

const ctx: ToolContext = { cwd: process.cwd() }

async function main(): Promise<void> {
  const registry = new ToolRegistry().register(ReadTool)

  // ① 给模型看的工具描述（这就是真正发给 API 的 tools 数组里的一项）
  const [spec] = registry.specs()
  const props = (spec!.input_schema as { properties?: Record<string, unknown> }).properties ?? {}

  // ② 模型"说"：我要调 Read，参数是 { path: 'package.json' }
  const toolUse: Extract<ContentBlock, { type: 'tool_use' }> = {
    type: 'tool_use',
    id: 'tu_1',
    name: 'Read',
    input: { path: 'package.json' },
  }

  const good = await runTool(registry.get('Read')!, toolUse.input, ctx)

  // ③ 把结果包装成回给模型的 tool_result 块（必须与 tool_use 的 id 配对）
  const resultBlock: ContentBlock = {
    type: 'tool_result',
    tool_use_id: toolUse.id,
    content: good.output,
    ...(good.isError ? { is_error: true } : {}),
  }

  // ④ 三种出错情形：都不该崩，都要返回 isError
  const missing = await runTool(registry.get('Read')!, { path: '不存在的文件.ts' }, ctx)
  const badArgs = await runTool(registry.get('Read')!, {}, ctx) // 缺必填的 path
  const badType = await runTool(registry.get('Read')!, { path: 'package.json', limit: 'abc' }, ctx)

  // ⑤ fail-closed 验证：定义工具时忘了声明，默认必须是最保守的
  const forgot = defineTool({
    name: 'Dangerous',
    description: '故意不声明安全性',
    inputSchema: z.object({}),
    async call() {
      return { output: 'ok' }
    },
  })

  // ── 后半部分：Glob / Grep / Write / Edit ────────────────
  const tmp = mkdtempSync(join(tmpdir(), 'agent-runtime-'))
  const tmpCtx: ToolContext = { cwd: tmp }

  const globAll = await runTool(GlobTool, { pattern: 'src/**/*.ts' }, ctx)
  const globNone = await runTool(GlobTool, { pattern: 'src/**/*.rb' }, ctx)

  const grepHit = await runTool(GrepTool, { pattern: 'runAgent', include: '*.ts' }, ctx)
  const grepBad = await runTool(GrepTool, { pattern: '([unclosed', include: '*.ts' }, ctx)

  const newFile = 'notes/hello.txt'
  const write1 = await runTool(WriteTool, { path: newFile, content: 'alpha\nbeta\nalpha\n' }, tmpCtx)
  const write2 = await runTool(WriteTool, { path: newFile, content: 'again' }, tmpCtx)

  const editUnique = await runTool(
    EditTool,
    { path: newFile, oldString: 'beta', newString: 'BETA' },
    tmpCtx,
  )
  const editMissing = await runTool(
    EditTool,
    { path: newFile, oldString: 'not-exist', newString: 'x' },
    tmpCtx,
  )
  const editAmbiguous = await runTool(
    EditTool,
    { path: newFile, oldString: 'alpha', newString: 'X' },
    tmpCtx,
  )
  const editAll = await runTool(
    EditTool,
    { path: newFile, oldString: 'alpha', newString: 'X', replaceAll: true },
    tmpCtx,
  )
  const finalContent = readFileSync(join(tmp, newFile), 'utf8')
  const escape = await runTool(WriteTool, { path: '../../escape.txt', content: 'x' }, tmpCtx)

  writeFileSync(join(tmp, 'dummy.txt'), 'x')

  const checks: Array<[string, boolean, string]> = [
    ['工具被注册', registry.has('Read'), registry.list().map((t) => t.name).join(',')],
    ['生成 JSON Schema', spec!.name === 'Read' && 'path' in props, Object.keys(props).join(',')],
    ['参数必填被识别', JSON.stringify(spec!.input_schema).includes('required'), 'required 含 path'],
    ['正常读取文件成功', !good.isError && good.output.includes('package.json'), `${good.output.length} 字符`],
    ['输出带行号', /\n\s*1\t/.test(good.output), '第 1 行有行号前缀'],
    ['tool_result 与 tool_use 配对', resultBlock.type === 'tool_result' && resultBlock.tool_use_id === 'tu_1', resultBlock.type === 'tool_result' ? resultBlock.tool_use_id : '(错)'],
    ['文件不存在 → isError', missing.isError === true, missing.output.slice(0, 24)],
    ['缺必填参数 → isError', badArgs.isError === true && badArgs.output.includes('不合法'), '被 zod 拦下'],
    ['参数类型错 → isError', badType.isError === true, 'limit 应为数字'],
    ['未声明安全性 → 默认 false', forgot.isReadOnly === false && forgot.isConcurrencySafe === false, 'fail-closed'],
    ['Glob 找到 ts 文件', !globAll.isError && globAll.output.includes('runAgent.ts'), globAll.output.split('\n')[0] ?? ''],
    ['Glob 无匹配不报错', !globNone.isError && globNone.output.includes('没有匹配'), globNone.output],
    ['Glob 跳过 node_modules', !globAll.output.includes('node_modules'), '依赖目录已排除'],
    ['Grep 命中内容', !grepHit.isError && grepHit.output.includes('runAgent.ts'), grepHit.output.split('\n')[1]?.slice(0, 40) ?? ''],
    ['Grep 非法正则 → isError', grepBad.isError === true, '被拦下'],
    ['Write 新建成功', !write1.isError && write1.output.includes('已创建'), write1.output],
    ['Write 拒绝覆盖已有文件', write2.isError === true && write2.output.includes('Edit'), '引导改用 Edit'],
    ['Edit 唯一匹配可改', !editUnique.isError && finalContent.includes('BETA'), 'beta → BETA'],
    ['Edit 找不到原文 → isError', editMissing.isError === true, '提示确认缩进'],
    ['Edit 多处匹配 → 拒绝', editAmbiguous.isError === true && editAmbiguous.output.includes('2 次'), '逼模型写精确'],
    ['Edit replaceAll 生效', !editAll.isError && !finalContent.includes('alpha'), '两处都替换'],
    ['路径越界被拦截', escape.isError === true && escape.output.includes('超出工作目录'), '不许跑出 cwd'],
  ]

  console.log('\n  冒烟测试 —— 工具系统\n')
  let failed = 0
  for (const [name, ok, detail] of checks) {
    console.log(`  ${ok ? '\x1b[32m✓\x1b[0m' : '\x1b[31m✗\x1b[0m'} ${name}  \x1b[2m${detail}\x1b[0m`)
    if (!ok) failed += 1
  }

  console.log('\n  ── 模型看到的工具描述 ──')
  console.log(`\x1b[2m${JSON.stringify(spec, null, 2).split('\n').slice(0, 12).join('\n')}\x1b[0m`)

  console.log('\n  ── 执行结果回给模型的前 8 行 ──')
  console.log(`\x1b[2m${good.output.split('\n').slice(0, 8).join('\n')}\x1b[0m`)

  console.log(
    failed === 0
      ? '\n  \x1b[32m全部通过。工具系统可用，下一步是把它们接进主循环。\x1b[0m\n'
      : `\n  \x1b[31m${failed} 项失败\x1b[0m\n`,
  )
  process.exit(failed === 0 ? 0 : 1)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
