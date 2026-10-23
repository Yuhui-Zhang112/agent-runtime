# agent-runtime

![CI](https://github.com/YOUR_USERNAME/agent-runtime/actions/workflows/ci.yml/badge.svg)

从 0 到 1 复现的生产级 AI 编程智能体运行时内核。参考蓝本是 Claude Code 的源码快照（`~/Desktop/src`，51 万行）。

**当前进度：Phase 0 完成** —— 流式调用内核可用，终端可对话。

## 快速开始

```bash
npm install
cp .env.example .env      # 填入你的 API key（Anthropic 或任意 OpenAI 兼容接口）
npm run smoke             # 零 API key 的冒烟测试，验证流式内核
npm run dev               # 启动对话 REPL
```

`npm run smoke` 会起一个本地假 SSE 服务端，端到端验证流式内核。**没有 API key 也能跑**，建议每次改动内核后都跑一遍。

## 目录结构

```
src/
├── types/message.ts     消息类型系统（参考源码中缺失，依据消费点重建）
├── api/
│   ├── types.ts         provider 抽象 + 统一流事件
│   ├── anthropic.ts     Anthropic provider
│   └── openai.ts        OpenAI 兼容 provider（手写 SSE 解析，无 SDK）
├── core/
│   └── callModel.ts     流式调用生成器 —— 主循环将来的唯一入口
├── dev/smoke.ts         冒烟测试（本地假服务端，零依赖）
└── cli.ts               Phase 0 入口 REPL
```

## 关键设计

- **provider 无关的内部表示**：所有 provider 的流事件统一成 Anthropic 形状，由 `callModel` 单点消费。新增 provider 只写翻译器，主循环 / Trace / Eval 不用改。这也是后面做「异构后端对比评测」的地基。
- **消息树**：每条消息带 `uuid` + `parentUuid`，子 agent / 后台任务的分支靠 `parentUuid` 挂在主干上。
- **最后一个 yield 即终态**：`for-await` 拿不到 generator 的 return value，参考源码同样采用这个约定。

## 与参考源码的对照

| 本文件 | 对应源码 | 说明 |
|---|---|---|
| `types/message.ts` | `types/message.ts`（缺失） | 依据 30+ 消费点重建 |
| `api/types.ts` | `StreamEvent` 定义 | 统一流事件形状 |
| `core/callModel.ts` | `query.ts` 的 `callModel` 部分 | 目前只实现了流式累积 |
| `cli.ts` | `entrypoints/cli.tsx` + `screens/REPL.tsx` | 极简版 |

## 下一步（Phase 1 · Agent 主循环闭环）

目标：模型能调工具 → 拿到结果 → 继续推理，直到完成任务。约 2500 行。

1. `Tool` 契约 + `buildTool()` fail-closed 默认值工厂（对齐 `Tool.ts`）
2. `while(true)` 主循环 + `needsFollowUp` 标志 —— **不要用 `stop_reason`**，源码注释明确说它不可靠
3. `runTools()`：`isConcurrencySafe` 分组 → 串行 / 并发（上限 10）
4. MVP 工具 5 个：`Bash` / `Read` / `Write` / `Edit` / `Glob`+`Grep`
5. **`ensureToolResultPairing()`** —— 最容易踩且后果最严重的一步：任何一个 tool_use 没有配对结果，API 会 400、会话直接死锁
6. `maxTurns` 终止 + `withRetry` 指数退避

验收标准：让它「读一下这个项目，写个 README.md」，能自主完成。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 启动对话 REPL（`/exit` 退出 · `/stats` 用量 · `/clear` 清空） |
| `npm run smoke` | 冒烟测试，零 API key |
| `npm run typecheck` | 类型检查 |
