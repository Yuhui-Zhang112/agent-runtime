/**
 * 工具契约（Tool Contract）
 *
 * 一句话理解：模型是"脑"，工具是"手和脚"。
 * 这份文件规定「一只手」必须长什么样 —— 只要符合这个形状，
 * 内置工具 / MCP 外部工具 / 技能工具就能被主循环一视同仁地调用。
 *
 * 三个必须记住的设计（对齐参考源码）：
 *  1. fail-closed：isReadOnly / isConcurrencySafe 都默认 false。
 *     新工具天然"被认为有副作用、不能并发"，写工具的人必须主动声明安全，
 *     而不是系统默认信任 —— 出事时损失最小。
 *  2. 参数用 zod 校验：模型给的参数永远不可信（它可能写错、可能 hallucinate），
 *     必须先 safeParse，失败就返回 isError 结果，绝不让异常往上冒。
 *  3. 工具执行失败不抛异常，而是返回一个 isError 的"结果"。
 *     因为工具结果是要回给模型看的 —— 让模型知道"失败了、为什么"，
 *     它才能自己改正。抛异常只会让整个会话崩掉。
 */

import { z } from 'zod'
import { zodToJsonSchema } from 'zod-to-json-schema'
import type { ToolSpec } from '../api/types.js'

/** 工具执行结果。output 是回给模型看的文本 */
export interface ToolResult {
  output: string
  isError?: boolean
}

export interface ToolContext {
  /** 当前工作目录 —— 相对路径都基于它解析 */
  cwd: string
  signal?: AbortSignal
  /** 进度回调：流式地把中间过程报给上层（Trace 与 UI 用） */
  onProgress?: (text: string) => void
}

/* eslint-disable @typescript-eslint/no-explicit-any */
export interface Tool<I = any> {
  /** 工具名，模型用它来点名调用。建议大驼峰：Read / Bash / Edit */
  name: string
  /** 给模型看的说明。写得好不好，直接决定模型会不会用对 */
  description: string
  /** 参数的 zod schema，兼做「校验」和「生成 JSON Schema 给模型看」两件事 */
  inputSchema: z.ZodType<I>
  /** 是否只读（不修改任何东西）。默认 false = 不信任 */
  isReadOnly: boolean
  /** 能否与其他只读工具并发执行。默认 false = 串行，最安全 */
  isConcurrencySafe: boolean
  /** 真正的执行逻辑 */
  call(input: I, ctx: ToolContext): Promise<ToolResult>
}

export interface ToolDefinition<I> {
  name: string
  description: string
  inputSchema: z.ZodType<I>
  isReadOnly?: boolean
  isConcurrencySafe?: boolean
  call(input: I, ctx: ToolContext): Promise<ToolResult>
}

/**
 * 定义工具。这里唯一做的事是**补默认值 —— 且默认是最保守的**。
 * 你不在定义里声明 isReadOnly，它就永远是 false。
 */
export function defineTool<I>(spec: ToolDefinition<I>): Tool<I> {
  return {
    isReadOnly: false,
    isConcurrencySafe: false,
    ...spec,
  }
}

/** 转成发给模型的工具描述（JSON Schema） */
export function toToolSpec(tool: Tool<any>): ToolSpec {
  const schema = zodToJsonSchema(tool.inputSchema, {
    target: 'jsonSchema7',
    $refStrategy: 'none',
  }) as Record<string, unknown>
  return {
    name: tool.name,
    description: tool.description,
    input_schema: schema,
  }
}

/**
 * 安全执行一个工具：校验参数 → 调用 → 兜住所有异常。
 * 无论发生什么都返回 ToolResult，绝不抛异常到主循环。
 */
export async function runTool(
  tool: Tool<any>,
  rawInput: unknown,
  ctx: ToolContext,
): Promise<ToolResult> {
  const parsed = tool.inputSchema.safeParse(rawInput ?? {})
  if (!parsed.success) {
    return {
      output:
        `工具 ${tool.name} 收到不合法的参数：\n` +
        parsed.error.issues.map((i) => `  - ${i.path.join('.') || '(根)'}: ${i.message}`).join('\n'),
      isError: true,
    }
  }

  try {
    return await tool.call(parsed.data, ctx)
  } catch (err) {
    return {
      output: `工具 ${tool.name} 执行失败：${err instanceof Error ? err.message : String(err)}`,
      isError: true,
    }
  }
}

/** 简易工具注册表：主循环要按名字找到工具 */
export class ToolRegistry {
  private readonly map = new Map<string, Tool<any>>()

  register(...tools: Tool<any>[]): this {
    for (const t of tools) this.map.set(t.name, t)
    return this
  }

  get(name: string): Tool<any> | undefined {
    return this.map.get(name)
  }

  has(name: string): boolean {
    return this.map.has(name)
  }

  list(): Tool<any>[] {
    return [...this.map.values()]
  }

  /** 发给模型的工具清单 */
  specs(): ToolSpec[] {
    return this.list().map(toToolSpec)
  }
}
