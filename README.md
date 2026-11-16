# agent-runtime

![CI](https://github.com/Yuhui-Zhang112/agent-runtime/actions/workflows/ci.yml/badge.svg)

从 0 到 1 手写的 **AI 编程智能体运行时内核**。参考蓝本是 Claude Code 的源码快照（51 万行 TS/TSX），但源文件未被修改——它是参考书，不是模板。

**它属于哪一层**：LLM 系统可分为模型层 / 运行时（框架）层 / 应用层 / 业务层。本项目实现的是**运行时层**——即 LangChain、LangGraph 本体所在的那一层，而不是用它们搭 RAG、写业务 Agent 的应用层。这里没有「接个 API + 做个界面」，只有主循环、消息树、工具执行与上下文管理。

**当前进度：Phase 1 完成 + 服务化** —— agent 能自主调工具完成任务，且能以 HTTP 服务的形态对外提供能力。类型检查通过，6 组冒烟测试共 120 项断言全部通过（均无需 API key）；GitHub Actions 在每次 push 时复跑同一套验证。

## 快速开始

```bash
npm install
cp .env.example .env      # 填入 API key（Anthropic 或任意 OpenAI 兼容接口）

npm run smoke:all         # 零 API key 冒烟测试（120 项），验证内核没坏
npm run dev               # 终端对话 REPL
npm run serve             # 以 HTTP 服务方式运行
```

`npm run smoke:all` 不需要 API key —— 它用剧本模型冒充真实厂商。**没有 key 也能验证内核是活的**，建议每次改动后都跑一遍。

## 两种运行形态

| 形态 | 命令 | 用在哪 |
|---|---|---|
| **CLI** | `npm run dev` | 自己在终端里用 |
| **服务** | `npm run serve` | 部署给别人调 |

服务形态相比 CLI 多了五样东西，每样都是被生产环境逼出来的：多会话隔离、鉴权、并发闸门、成本熔断、优雅退出。

```bash
# 起服务
AUTH_TOKEN=my-secret API_KEY=sk-... PORT=8787 npm run serve

# 建会话
curl -X POST http://127.0.0.1:8787/v1/sessions -H 'Authorization: Bearer my-secret'

# 跑一次（SSE 流式返回每一轮的 trace 与工具事件）
curl -N -X POST http://127.0.0.1:8787/v1/sessions/<id>/runs \
  -H 'Authorization: Bearer my-secret' \
  -d '{"text":"读一下 package.json，告诉我这是什么项目"}'
```

> 未设 `AUTH_TOKEN` 时服务只监听 localhost —— 想对外暴露必须显式配密钥。

### Docker

```bash
docker build -t agent-runtime .
docker run -p 8787:8787 -e API_KEY=sk-... -e AUTH_TOKEN=my-secret agent-runtime
```

## 目录结构

```
src/
├── types/message.ts     消息类型系统（参考源码中缺失，依据 30+ 消费点重建）
├── api/
│   ├── types.ts         provider 抽象 + 统一流事件 + ProviderError
│   ├── errors.ts        各家 SDK 错误 → ProviderError（重试的唯一判据）
│   ├── anthropic.ts     Anthropic provider
│   └── openai.ts        OpenAI 兼容 provider（手写 SSE 解析，无 SDK）
├── core/
│   ├── callModel.ts     流式调用生成器
│   ├── tool.ts          工具契约（fail-closed）
│   ├── runAgent.ts      主循环 ★
│   ├── toolExecution.ts 并发调度（波次分组 / 顺序还原 / 中断收敛）
│   └── withRetry.ts     指数退避重试
├── tools/               Read / Glob / Grep / Write / Edit + 路径安全
├── server/              服务层：配置 / 会话 / 日志 / HTTP+SSE
├── server.ts            服务入口
├── cli.ts               CLI 入口
└── dev/                 剧本模型 + 6 组冒烟测试
```

## 关键设计

- **配对不可断**：每个 `tool_use` 必须有 `tool_result`。少一个，API 400、会话永久死锁。中断 / 降级 / 异常三条路径都会补合成结果。
- **不信 `stop_reason`**：参考源码 `query.ts:554` 注释明确说它不可靠。唯一可信信号是「这一轮回复里有没有 tool_use 块」。
- **默认不信任**：工具默认有副作用、默认不能并发；认不出的错误默认不重试。
- **provider 无关**：所有厂商的流事件统一成 Anthropic 形状，新增 provider 只写翻译器。
- **Trace 从第一天就埋**：每轮记录 token / 耗时 / 成本 / 并发度 / 重试次数，是将来做可视化与评测的原始数据。
- **并发但守序**：只读工具并行、写操作独占，且结果顺序必须与请求顺序一致（乱序不报错，只让模型变笨）。

## 为什么自研这一层（而不是直接调 LangChain）

不是为了「不用框架」，而是因为**有些问题只有站在这一层才碰得到**：

- 应用层的答案通常是「换个配置项」，运行时层的答案是「改机制」。上下文太长时，应用层只能换更大窗口或调框架的 memory 配置；在这里可以直接对消息树做**可恢复压缩**（把大块工具结果换成占位符，需要时重新 Read），并对 `tool_use` / `tool_result` 配对边界做完整性自检。
- 只有自己定义消息类型、自己保证配对，才谈得上做压缩策略的 A/B 评测（成本降 X% / 引用丢失率 +Y%）。这层对框架使用者是黑盒。
- 自研过等价层之后，LangChain / LangGraph 的抽象不再是黑盒：读它的源码、定位它内部哪一层的 bug，比只会调 API 的人快得多。生产环境用框架时，这是向下兼容，不是对立。

验证层同样是为这一层服务的：`src/dev/scriptedModel.ts` 用确定输出的剧本模型冒充厂商，能稳定复现「网络腰斩半个 JSON」「中途中断」这类真实 API 上碰运气都碰不到的场景，因此 `npm run smoke:all` 不需要任何密钥，且结果可复现。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 终端 REPL |
| `npm run serve` | HTTP 服务 |
| `npm run smoke:all` | 全部冒烟测试（120 项，零 API key） |
| `npm run smoke` / `smoke:tool` / `smoke:agent` / `smoke:exec` / `smoke:retry` / `smoke:server` | 分模块跑 |
| `npm run typecheck` | 类型检查 |
| `npm run build` | 编译到 `dist/` |
| `npm start` | 运行编译产物 |

## 下一步

- **Phase 2 · 权限系统** —— 做完才能加 `BashTool`（能执行任意命令，没有权限等于裸奔）
- **Phase 3 · 上下文工程** ★ —— 差异化主战场：压缩策略的设计与 A/B 评测（成本 / 任务成功率 / 引用丢失率）
- **Phase 4 · 多智能体** —— 时间紧可砍
- **Phase 5 · 可观测性 + 包装** ★ —— Trace 可视化与 Eval 报告的产出阶段
