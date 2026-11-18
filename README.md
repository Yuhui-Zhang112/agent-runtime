# agent-runtime

![CI](https://github.com/Yuhui-Zhang112/agent-runtime/actions/workflows/ci.yml/badge.svg)

从 0 到 1 手写的 **AI 编程智能体运行时内核**。参考蓝本是 Claude Code 的源码快照（51 万行 TS/TSX），但源文件未被修改——它是参考书，不是模板。

**它属于哪一层**：LLM 系统可分为模型层 / 运行时（框架）层 / 应用层 / 业务层。本项目实现的是**运行时层**——即 LangChain、LangGraph 本体所在的那一层，而不是用它们搭 RAG、写业务 Agent 的应用层。这里没有「接个 API + 做个界面」，只有主循环、消息树、工具执行、权限裁决与上下文管理。

**当前进度：Phase 5 完成** —— 运行时内核之上补齐了**场景 Agent、统一 Eval 门禁、Trace 只读 API 与 TypeScript 看板**，项目成为真正的 TS 全栈。核心是一条可量化的主线：可恢复上下文压缩（Phase 3）→ 20 个微任务测「省不省钱」→ 12 个完整 issue 定位任务测「活还能不能干完、参数该怎么定」→ 两套实验合并成看板数据源，并由「不可复现就失败」的门禁守住。类型检查通过，**9 组冒烟测试共 294 项断言**全部通过（均无需 API key）；GitHub Actions 每次 push 复跑同一套验证、重跑实验并校验报告零 diff。

> 实验报告：[compaction A/B](reports/compaction-experiment.md) · [场景回归](reports/scenario-eval.md) · [看板数据源](reports/eval-summary.json)（随仓库提交，含完整数据、参数扫描与诚实边界）

## 快速开始

```bash
npm install
cp .env.example .env      # 填入 API key（Anthropic 或任意 OpenAI 兼容接口）

npm run smoke:all         # 零 API key 冒烟测试（9 组 294 项），验证内核没坏
npm run eval:all          # 零 API key 跑两套实验 + 生成看板数据源，不可复现就失败
npm run build:all         # 编译内核（dist/）+ TypeScript 看板（public/dashboard.js）
npm run dev               # 终端对话 REPL
npm run serve             # 以 HTTP 服务方式运行，然后打开 /dashboard
```

`smoke:all` / `eval:all` 都不需要 API key —— 它们用确定性模型冒充真实厂商。**没有 key 也能验证内核是活的、实验是可复现的、看板是有数据的**。

## 两种运行形态

| 形态 | 命令 | 用在哪 |
|---|---|---|
| **CLI** | `npm run dev` | 自己在终端里用 |
| **服务** | `npm run serve` | 部署给别人调 |

服务形态相比 CLI 多出这些，每样都是被生产环境逼出来的：多会话隔离、鉴权、并发闸门、成本熔断、优雅退出、审批从终端问答变成可被 HTTP 编排的异步请求，以及 Trace 的 JSONL 落盘回放。

```bash
# 起服务
AUTH_TOKEN=my-secret API_KEY=sk-... PORT=8787 TRACE_DIR=./traces npm run serve

# 建会话
curl -X POST http://127.0.0.1:8787/v1/sessions -H 'Authorization: Bearer my-secret'

# 跑一次（SSE 流式返回每一轮的 trace、工具事件、权限事件与压缩事件）
curl -N -X POST http://127.0.0.1:8787/v1/sessions/<id>/runs \
  -H 'Authorization: Bearer my-secret' \
  -d '{"text":"读一下 package.json，告诉我这是什么项目"}'

# 查当前压缩策略
curl http://127.0.0.1:8787/v1/compaction -H 'Authorization: Bearer my-secret'

# 看板：浏览器打开 http://127.0.0.1:8787/dashboard
# 若服务设了 AUTH_TOKEN，在右上角填一次即可（数据接口全部走同一道鉴权）
```

> 未设 `AUTH_TOKEN` 时服务只监听 localhost —— 想对外暴露必须显式配密钥。
> 看板页面本身是空壳、不含数据，因此无需鉴权；所有数据都由下表这些**只读**接口提供。

| 接口 | 返回 | 数据源 |
|---|---|---|
| `GET /dashboard` | 看板 HTML + `app.js` | `public/`（静态白名单，防路径穿越） |
| `GET /v1/traces` | run 列表、汇总、压缩时间线 | `TRACE_DIR` 下的 JSONL |
| `GET /v1/traces/:runId` | 某次 run 的逐轮 token / 成本 / 工具 / 压缩事件 | 同上，重启后仍可回放 |
| `GET /v1/eval` | 两套实验的合并结论 | `reports/eval-summary.json` |
| `GET /v1/scenarios` | 场景元数据与样例任务 | 代码内的 fixture 定义 |

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
│   ├── compaction.ts    可恢复上下文压缩 ★（纯函数 / 五项自检 / 回滚）
│   ├── traceStore.ts    Trace 持久化与汇总 ★（JSONL 落盘 + 回放）
│   ├── runAgent.ts      主循环 ★
│   ├── toolExecution.ts 并发调度 + 执行前统一权限预检
│   └── withRetry.ts     指数退避重试
├── tools/               Read / Glob / Grep / Write / Edit / Bash + 路径安全
├── server/              配置 / 会话 / 日志 / HTTP+SSE / 审批队列（含 4 个只读 API + 看板托管）
├── scenarios/           ★ 合成仓库 + 12 个带 ground truth 的 issue + 确定性模型 + zod 判分
├── server.ts            服务入口
├── cli.ts               CLI 入口
├── dev/
│   ├── scriptedModel.ts   剧本模型（冒充厂商，零 key 冒烟）
│   ├── evalModel.ts       评测模型（会读历史，按真实上下文计 token）
│   ├── evalTasks.ts       固定种子回归任务集（20 个埋值-引用微任务）
│   ├── evalCompaction.ts  A/B/C 对照 + 12 点参数扫描 + 报告生成
│   ├── evalScenario.ts    ★ 场景回归：4 组对照 + 6 点门槛扫描 + 逐任务判分
│   ├── evalAll.ts         ★ 统一门禁：校验可复现、合并两套报告、产出 eval-summary.json
│   └── smoke*.ts          9 组冒烟测试（294 项断言，含服务 API 组与 Eval 门禁组）
├── web/dashboard.ts     ★ 看板前端（TS，无框架，手绘 SVG 折线/柱图）
├── public/              看板 HTML 壳 + 编译产物 dashboard.js（随仓库提交，零构建可用）
└── reports/             实验报告（md + json，自动生成且逐字节可复现）
```

## 关键设计

- **配对不可断**：每个 `tool_use` 必须有 `tool_result`。少一个，API 400、会话永久死锁。中断 / 降级 / 异常 / **权限拒绝** / **上下文压缩**五条路径都会补合成结果或保留结构。
- **不信 `stop_reason`**：参考源码 `query.ts:554` 注释明确说它不可靠。唯一可信信号是「这一轮回复里有没有 tool_use 块」。
- **默认不信任**：工具默认有副作用、默认不能并发、未声明风险级别的工具按最高风险算；认不出的错误默认不重试；压缩自检不过默认回滚。
- **两层安全不可互绕**：策略层可配置（模式 / 规则 / 审批），结构层不可配置（危险命令、密钥隔离、超时）。`bypassPermissions` 只跳过询问，跳不过硬约束。
- **provider 无关**：所有厂商的流事件统一成 Anthropic 形状，新增 provider 只写翻译器。
- **Trace 从第一天就埋，且能落盘**：每轮记录 token / 耗时 / 成本 / 并发度 / 重试次数 / 被拒次数 / **压缩节省量**；`TRACE_DIR` 一设就写 JSONL，重启后可回放。
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

规则形如 `{ "tool": "Bash", "action": "allow", "pattern": "npm *" }`。优先级：**硬约束 > deny > ask > allow**，带 `pattern` 的规则比不带的具体。审批超时、审批 UI 崩了、压根没有审批通道，一律按拒绝（fail-closed）。`always` 只记住这一条确切命令，不整类放开。

### 拒绝不是异常

权限拒绝会产出一条 `isError` 的 `tool_result`，并把「为什么被拒、可以改用哪些只读工具」写进去，模型才有机会自己换条路。少一条结果就会留下孤儿 `tool_use`，API 直接 400、会话永久死锁。

### 审批在两种形态里

| 形态 | 审批门 |
|---|---|
| **CLI** | 终端问答：`y` 这一次 / `a` 记住这条 / `N` 拒绝；`/permissions`、`/mode`、`/allow` 管理规则 |
| **服务** | SSE 推 `permission_request` → 调用方 `POST /v1/approvals {"id","decision"}` → 队列放行；`GET /v1/permissions` 查状态，`POST /v1/permissions/rules` 运行时加规则 |

主循环与调度器完全不用改——审批门是注入的，CLI 换成终端问答、服务换成 HTTP 队列，仅此而已。

```bash
PERMISSION_MODE=default
PERMISSION_RULES='[{"tool":"Bash","action":"allow","pattern":"npm *"}]'
APPROVAL_TIMEOUT_MS=60000     # 超时按拒绝，绝不无限挂住一轮
```

### BashTool 的结构层清单

危险命令黑名单（`rm -rf /`、`sudo`、`curl … | sh`、fork bomb…）、敏感文件读取拦截（SSH 私钥 / 云凭证 / `.env`）、**子进程只拿环境变量白名单，API key 根本不传进去**、cwd 锁定、超时杀整个进程组（连派生子进程一起）、输出硬截断、中断即 kill。

> 诚实说明：命令的静态匹配是**纵深防御，不是沙箱**；变量拼接、编码、别名都能绕开字符串检查。真正的隔离边界是操作系统权限与容器非 root 用户（见 `Dockerfile`）。这一层负责的是「别让明显的手滑变成事故」。

## 上下文压缩与 A/B 评测（Phase 3）★

### 为什么非压不可

模型没有长期记忆：每一轮都要把之前全部历史重新发一遍。Agent 比聊天更惨——每调一次工具就把结果塞进历史，读一个文件动辄几千 token。于是三个问题同时来：撞窗口上限、成本按轮累加、模型在超长历史里找关键信息的准确率下降。**占地方的不是对话，是大块 `tool_result`**。

### 怎么做手术

不删任何消息，只把大块 `tool_result` 的**文本**换成一句占位符：

```
[上下文压缩] Read 的结果已折叠（原 11243 字符）。原文未删除，
需要精确内容时请重新调用 Read(path="src/foo.ts") 取回。
```

这是**可恢复压缩**——信息不是删了，是「收进抽屉」。三条铁律：

1. **配对不断**：只改块内文本，绝不删块 / 删消息，`uuid` / `parentUuid` 链原样保留。滑窗截断最容易把 `tool_use` 扔了留下 `tool_result`，API 直接 400。
2. **最近不碰**：末尾 N 条消息完全不动，模型正在用的上下文不能被抽走。
3. **自检回滚**：压完逐条体检（配对 / 首条 / 最近保护 / uuid 链 / 确有节省），任意一条不过就**整套丢弃**。「宁可不省这点钱，也绝不把坏消息发给 API」。

触发时机在**每轮问模型之前**，触发阈值、目标预算、保护窗口、最小折叠长度、是否可恢复全部可配（环境变量 / CLI `/compact` / 服务 `GET /v1/compaction`）。

### 实验结论（20 个任务 × 3 组 + 12 个参数点）

| 策略 | 成功 | 引用丢失率 | 累计 input tokens | 累计成本 |
|---|---:|---:|---:|---:|
| **A 基线（不压缩）** | 20/20 | 0% | 1,305,680 | $4.0220 |
| **B 压缩·不可恢复** | 0/20 | **100%** | 701,349 | $2.2090 |
| **C 压缩·可恢复** | 20/20 | 0% | 841,170 | **$2.6435** |

> 完整数据、参数扫描曲线与简历句式见 [reports/compaction-experiment.md](reports/compaction-experiment.md)。

- **成本降 34.3%**（input tokens 降 35.6%），引用丢失率 **+0.0pp**；代价是 20 次额外重读、多 20 轮。
- **去掉「可恢复」这一条，丢失率飙升 +100pp** —— B 组单价最便宜，却一个任务都没做对。真正值钱的不是折叠动作，是**可恢复性**。
- **参数扫描给出反直觉结论**：保护窗口设 8 条时成本降幅是 **−5.3%**（反而更贵）——压缩触发了、模型照样回去重读，但保护窗口太大几乎没省下 token。而保护窗口 2 条能降 60.5%，却过于激进。默认值是保守折中，不是最优；换任务集应重跑扫描再定参数。

### 实验方法（为什么这组数字可复现）

任务集是 20 个「**埋值 → 隔 5 轮噪音读大文件 → 必须引用精确值**」的回归任务，由固定种子 LCG 生成。评测模型是**会读历史的确定性假模型**：它的 `input_tokens` 按这一轮真正发给它的 messages 现算，最后一轮检查历史里那个精确值还在不在——在就答对，不在就看占位符提示重新 `Read`，取不回就答 `UNKNOWN`。三组除压缩策略外全部锁死；整个实验跑两遍，核心指标逐字段一致。

> **诚实边界（面试请主动讲）**：这不是真 LLM，测的是「信息在上下文里是否可达」这一条**架构机制**，不模拟注意力衰减、幻觉或指令遵循能力；token 是估算而非厂商计数。数字应表述为**架构层的可达性/成本指标**，不是真实业务任务成功率。主动讲清这一点，比被追问出来强得多。

## 场景 Agent 回归（Phase 4）★

Phase 3 的 20 个「埋值—引用」微任务回答的是**引用可达性**；但架构实验里省了钱，不代表业务流程还能干完。于是造了一个 L2 示范应用：**开源项目 issue 定位 Agent**。

固定种子生成 12 个 issue，每个都带 3 份大体积噪音文件撑大上下文；流程是 `Grep(keyword)` 定位候选 → `Read(rootFile)` 取精确证据标记 → 输出 JSON 结论（zod 校验）。ground truth 在造 fixture 时就已知，所以「根因文件 + 缺陷类型 + 精确证据标记三项全中」可以**自动判分**，模型拿不到证据只能输出 `category="unknown"`，不会编造。

| 策略 | 成功 | 证据丢失率 | 累计成本 | 额外重读 |
|---|---:|---:|---:|---:|
| **A 基线（不压缩）** | 12/12 | 0% | $0.6692 | 0 |
| **B 压缩·不可恢复** | **0/12** | **100%** | $0.5818 | 0 |
| **C 照搬 Phase 3 默认参数** | 12/12 | 0% | **$0.7107（+6.2%）** | 12 |
| **D 只折大结果（推荐）** | 12/12 | 0% | **$0.6120（−8.5%）** | 0 |

> 完整数据、6 点门槛扫描、逐任务判分与简历句式见 [reports/scenario-eval.md](reports/scenario-eval.md)。

**两个结论叠起来才完整**：① B vs C 证明**可恢复性决定会不会做错**；② C vs D 证明**折叠粒度决定会不会白省钱**。C 组把根因文件一起折了，逼出 12 次「回头重读 + 再重发一遍全历史」，省下的 token 全被吃光还倒赔 —— 只改 `minResultChars` 一个变量，门槛从 600 调到 2,400 字符，成本就从 **+6.2% 翻到 −8.5%**，而 8,000 以上则什么都不折、退化成基线。

这说明「压缩降本 X%」从来不是固定数字，它取决于任务里早期证据被重新引用的概率。**换任务集必须重跑这张表**，这正是把压缩放在消息树那一层才做得到的管控。

## 统一 Eval 门禁与 Trace 看板（Phase 5）★

两套实验各有各的报告，散着放着迟早会变成「手改过的数字」。Phase 5 把它们收进一条链：

```
eval:compaction ┐
                ├→ evalAll.ts（可复现校验 + 口径对齐）→ reports/eval-summary.json
eval:scenario  ┘                                          ↓
                                       GET /v1/eval → TypeScript 看板
TRACE_DIR/*.jsonl → GET /v1/traces[/:runId] ──────────────┘
```

- **门禁不是装饰**：`evalAll.ts` 任一报告的 `reproducible !== true` 就直接 `exit 1`；`smoke:eval` 再校验汇总确定性、结论方向、诚实边界未删、已提交产物与当前报告一致。
- **产物即源码**：`eval-summary.json` 故意不写时间戳，CI 重跑实验后用 `git diff --exit-code -- reports/` 断言零 diff；`public/dashboard.js` 也从 TS 重新编译并比对，禁止手改或提交陈旧产物。
- **看板无框架**：`web/dashboard.ts` 原生 DOM + 手绘 SVG（逐轮上下文折线、A/B 成本柱状、门槛敏感性、run 列表），无前端依赖 —— 和「自研薄层」的定位保持一致。页面只读三个接口，不含任何数据；服务设了 token 就在右上角填一次。

> **诚实边界（面试必须主动讲）**：驱动这两套实验的都是**确定性假模型，不是真实 LLM**；仓库是结构真实、内容合成的 fixture（真实目录、真实 Grep/Read、真实结果体积），不是从 GitHub 抓的真实 issue。因此「成功率」是**架构层证据可达率**，不能对外说成真实业务解决率。可迁移的是「固定任务集 + A/B 对照 + 自动判分 + 可复现验证」这套评测方法本身。

## 为什么自研这一层（而不是直接调 LangChain）

不是为了「不用框架」，而是因为**有些问题只有站在这一层才碰得到**：

- 应用层的答案通常是「换个配置项」，运行时层的答案是「改机制」。上下文太长时，应用层只能换更大窗口或调框架的 memory 配置；这里可以直接对消息树做可恢复压缩，并对 `tool_use` / `tool_result` 配对边界做完整性自检。
- 压缩策略的 A/B 评测要动的是消息树和配对边界 —— 这层对框架使用者是黑盒，他们只能等框架给配置项。
- 权限系统也一样：要拦的是「工具执行之前」那一瞬间，而用框架的人只看得到应用层回调。

验证层同样是为这一层服务的：`scriptedModel.ts` 能稳定复现「网络腰斩半个 JSON」「中途中断」「审批挂起」这类真实 API 上碰运气都碰不到的场景；`evalModel.ts` 进一步让「压缩省了钱」和「压缩让引用丢失」变成同一把尺子上的两个数；`scenarios/issueAgent.ts` 则把同一把尺子搬到完整业务流程上。因此全部 294 项断言与整份实验报告**不需要任何密钥**，且结果可复现。

「可复现」还得跨机器成立：`walkFiles()` 对目录项强制字典序，`Glob` 的 mtime 排序额外用路径兜底。原因是 `readdirSync` 的顺序由文件系统实现决定（macOS APFS 常按创建序、Linux ext4/overlayfs 常按哈希序），不排序时 Grep 的命中顺序与 `maxMatches` 截断集合会随机器漂移，工具结果内容一变，token 和成本就跟着变。CI 用「重跑实验后 `reports/` 零 diff」把这条锁死，冒烟里也有专门的契约断言防回归。

> 姿态说明：自研不是为了不用框架。自己写过这层之后，LangChain 就不再是黑盒 —— 出问题能定位到它内部哪一层。公司用框架，我读它的源码像读熟人写的；公司不用，我就是那层。

## 命令

| 命令 | 作用 |
|---|---|
| `npm run dev` | 终端 REPL（`/compact` 查状态、`/compact off\|on` 开关） |
| `npm run serve` | HTTP 服务（`/dashboard` 看板） |
| `npm run smoke:all` | 全部冒烟测试（9 组 294 项，零 API key） |
| `npm run eval:compaction` | 重跑压缩 A/B 实验（20 任务 × 3 组 + 12 点扫描） |
| `npm run eval:scenario` | 重跑场景回归（12 个 issue × 4 组 + 6 点门槛扫描） |
| `npm run eval:all` | 上面两套 + 统一门禁，产出 `reports/eval-summary.json`（**不可复现就失败**） |
| `npm run smoke:eval` | 毫秒级校验评测产物一致性、结论方向与诚实边界 |
| `npm run smoke` / `smoke:tool` / `smoke:agent` / `smoke:exec` / `smoke:retry` / `smoke:server` / `smoke:permission` / `smoke:compaction` | 分模块跑 |
| `npm run typecheck` | 类型检查 |
| `npm run build` / `build:web` / `build:all` | 编译内核到 `dist/` / 看板到 `public/` / 两者 |
| `npm start` | 运行编译产物 |

## 下一步

- **真实 LLM 小样本对照** —— 拿一小批真 issue 用真模型跑同一套 A/B，验证「架构层可达率」与真实解决率的相关性；这是把实验结论从机制证据推向业务证据的唯一办法。
- **token 级 SSE** —— 目前是轮次级流式。要拿到逐 token 增量，得把 `callModel` 的流事件透到服务层，是一次独立改造。
- **多智能体**（Subagent / Task / Team）—— 时间紧可砍，现有主循环已能承载多实例并发。
