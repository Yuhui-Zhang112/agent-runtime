# agent-runtime

![CI](https://github.com/Yuhui-Zhang112/agent-runtime/actions/workflows/ci.yml/badge.svg)

从 0 到 1 手写的 **AI 编程智能体运行时内核**。参考蓝本是 Claude Code 的源码快照（51 万行 TS/TSX），但源文件未被修改——它是参考书，不是模板。

**它属于哪一层**：LLM 系统可分为模型层 / 运行时（框架）层 / 应用层 / 业务层。本项目实现的是**运行时层**——即 LangChain、LangGraph 本体所在的那一层，而不是用它们搭 RAG、写业务 Agent 的应用层。这里没有「接个 API + 做个界面」，只有主循环、消息树、工具执行、权限裁决与上下文管理。

**当前进度：Phase 2 完成** —— 在主循环与服务化之上补齐了权限系统和 `BashTool`：模型能执行命令，但每次动手前都要过策略裁决；被拒绝也不会破坏 `tool_use` / `tool_result` 配对。类型检查通过，7 组冒烟测试共 **191 项断言**全部通过（均无需 API key）；GitHub Actions 在每次 push 时复跑同一套验证。

## 快速开始

```bash
npm install
cp .env.example .env      # 填入 API key（Anthropic 或任意 OpenAI 兼容接口）

npm run smoke:all         # 零 API key 冒烟测试（191 项），验证内核没坏
npm run dev               # 终端对话 REPL
npm run serve             # 以 HTTP 服务方式运行
```

`npm run smoke:all` 不需要 API key —— 它用剧本模型冒充真实厂商。**没有 key 也能验证内核是活的**，建议每次改动后都跑一遍。

## 两种运行形态

| 形态 | 命令 | 用在哪 |
|---|---|---|
| **CLI** | `npm run dev` | 自己在终端里用 |
| **服务** | `npm run serve` | 部署给别人调 |

服务形态相比 CLI 多出这些，每样都是被生产环境逼出来的：多会话隔离、鉴权、并发闸门、成本熔断、优雅退出，以及 Phase 2 之后新增的一条 —— **审批从终端问答变成可被 HTTP 编排的异步请求**。

```bash
# 起服务
AUTH_TOKEN=my-secret API_KEY=sk-... PORT=8787 npm run serve

# 建会话
curl -X POST http://127.0.0.1:8787/v1/sessions -H 'Authorization: Bearer my-secret'

# 跑一次（SSE 流式返回每一轮的 trace、工具事件与权限事件）
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
│   ├── tool.ts          工具契约（fail-closed，含风险级别）
│   ├── permissions.ts   权限引擎 ★（模式 / 规则 / 审批门 / 硬约束）
│   ├── runAgent.ts      主循环 ★
│   ├── toolExecution.ts 并发调度 + 执行前统一权限预检
│   └── withRetry.ts     指数退避重试
├── tools/               Read / Glob / Grep / Write / Edit / Bash + 路径安全
├── server/              配置 / 会话 / 日志 / HTTP+SSE / 审批队列
├── server.ts            服务入口
├── cli.ts               CLI 入口
└── dev/                 剧本模型 + 7 组冒烟测试
```

## 关键设计

- **配对不可断**：每个 `tool_use` 必须有 `tool_result`。少一个，API 400、会话永久死锁。中断 / 降级 / 异常 / **权限拒绝**四条路径都会补合成结果。
- **不信 `stop_reason`**：参考源码 `query.ts:554` 注释明确说它不可靠。唯一可信信号是「这一轮回复里有没有 tool_use 块」。
- **默认不信任**：工具默认有副作用、默认不能并发、未声明风险级别的工具按最高风险算；认不出的错误默认不重试。
- **两层安全不可互绕**：策略层可配置（模式 / 规则 / 审批），结构层不可配置（危险命令、密钥隔离、超时）。`bypassPermissions` 只跳过询问，跳不过硬约束。
- **provider 无关**：所有厂商的流事件统一成 Anthropic 形状，新增 provider 只写翻译器。
- **Trace 从第一天就埋**：每轮记录 token / 耗时 / 成本 / 并发度 / 重试次数 / **被权限拦下次数**，是将来做可视化与评测的原始数据。
- **并发但守序**：只读工具并行、写操作独占，且结果顺序必须与请求顺序一致（乱序不报错，只让模型变笨）。

## 权限系统（Phase 2）

模型能「想」，但能不能真的「动手」，由这一层说了算。`BashTool` 是权限面最大的工具，所以它必须等权限系统先落地才挂上去。

### 两层安全，互不替代

| 层 | 在哪 | 回答什么问题 | 能配置吗 |
|---|---|---|---|
| **策略层** | `core/permissions.ts` | 这次调用，用户允许吗 | 能：模式 / 规则 / 审批门 |
| **结构层** | 工具内部（`BashTool.ts`） | 就算用户同意，这事本身能干吗 | 不能 |

### 四种模式

| 模式 | 行为 |
|---|---|
| `default`（默认） | 只读放行；写文件 / 执行命令要问人 |
| `plan` | 只许看，写和执行一律拒绝 |
| `acceptEdits` | 写文件自动放行，命令仍需批准 |
| `bypassPermissions` | 跳过询问（硬约束仍生效） |

规则形如 `{ "tool": "Bash", "action": "allow", "pattern": "npm *" }`。优先级：**硬约束 > deny > ask > allow**，带 `pattern` 的规则比不带的具体。
审批超时、审批 UI 崩了、压根没有审批通道，一律按拒绝（fail-closed）。`always` 只记住这一条确切命令，不整类放开。

### 拒绝不是异常

权限拒绝会产出一条 `isError` 的 `tool_result`，并把「为什么被拒、可以改用哪些只读工具」写进去，模型才有机会自己换条路。少一条结果就会留下孤儿 `tool_use`，API 直接 400、会话永久死锁。

### 审批在两种形态里

| 形态 | 审批门 |
|---|---|
| **CLI** | 终端问答：`y` 这一次 / `a` 记住这条 / `N` 拒绝；`/permissions`、`/mode`、`/allow` 管理规则 |
| **服务** | SSE 推 `permission_request` → 调用方 `POST /v1/approvals {"id","decision"}` → 队列放行；`GET /v1/permissions` 查状态，`POST /v1/permissions/rules` 运行时加规则 |

主循环与调度器完全不用改——审批门是注入的，CLI 换成终端问答、服务换成 HTTP 队列，仅此而已。

```bash
# 服务启动时预置规则 / 切换模式
PERMISSION_MODE=default
PERMISSION_RULES='[{"tool":"Bash","action":"allow","pattern":"npm *"}]'
APPROVAL_TIMEOUT_MS=60000     # 超时按拒绝，绝不无限挂住一轮
```

### BashTool 的结构层清单

危险命令黑名单（`rm -rf /`、`sudo`、`curl … | sh`、fork bomb…）、敏感文件读取拦截（SSH 私钥 / 云凭证 / `.env`）、**子进程只拿环境变量白名单，API key 根本不传进去**、cwd 锁定、超时杀整个进程组（连派生子进程一起）、输出硬截断、中断即 kill。

> 诚实说明：命令的静态匹配是**纵深防御，不是沙箱**；变量拼接、编码、别名都能绕开字符串检查。真正的隔离边界是操作系统权限与容器非 root 用户（见 `Dockerfile`）。这一层负责的是「别让明显的手滑变成事故」。

## 为什么自研这一层（而不是直接调 LangChain）

不是为了「不用框架」，而是因为**有些问题只有站在这一层才碰得到**：

- 应用层的答案通常是「换个配置项」，运行时层的答案是「改机制」。上下文太长时，应用层只能换更大窗口或调框架的 memory 配置；在这里可以直接对消息树做**可恢复压缩**（把大块工具结果换成占位符，需要时重新 Read），并对 `tool_use` / `tool_result` 配对边界做完整性自检。
- 只有自己定义消息类型、自己保证配对，才谈得上做压缩策略的 A/B 评测（成本降 X% / 引用丢失率 +Y%）。这层对框架使用者是黑盒。
- 权限系统也一样：要拦的是「工具执行之前」那一瞬间，而用框架的人只看得到应用层回调。

验证层同样是为这一层服务的：`src/dev/scriptedModel.ts` 用确定输出的剧本模型冒充厂商，能稳定复现「网络腰斩半个 JSON」「中途中断」「审批挂起」这类真实 API 上碰运气都碰不到的场景，因此 `npm run smoke:all` 不需要任何密钥，且结果可复现。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 终端 REPL |
| `npm run serve` | HTTP 服务 |
| `npm run smoke:all` | 全部冒烟测试（191 项，零 API key） |
| `npm run smoke` / `smoke:tool` / `smoke:agent` / `smoke:exec` / `smoke:retry` / `smoke:server` / `smoke:permission` | 分模块跑 |
| `npm run typecheck` | 类型检查 |
| `npm run build` | 编译到 `dist/` |
| `npm start` | 运行编译产物 |

## 下一步

- **Phase 3 · 上下文工程** ★ —— 下一步，差异化主战场：压缩策略的设计与 A/B 评测（成本 / 任务成功率 / 引用丢失率）
- **Phase 4 · 多智能体** —— 时间紧可砍
- **Phase 5 · 可观测性 + 包装** ★ —— Trace 持久化、可视化看板与离线回归评测
