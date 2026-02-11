![ClawRouter Banner](assets/banner.png)

<div align="center">

将每个请求路由到最便宜的能处理它的模型。
一个钱包，30+模型，零 API 密钥。

[![npm](https://img.shields.io/npm/v/@blockrun/clawrouter.svg)](https://npmjs.com/package/@blockrun/clawrouter)
[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.7-blue.svg)](https://typescriptlang.org)
[![Node](https://img.shields.io/badge/node-%E2%89%A520-brightgreen.svg)](https://nodejs.org)

[英文文档](README.md) · [配置文档](docs/configuration.md) · [功能特性](docs/features.md) · [故障排除](docs/troubleshooting.md)

</div>

---

```
"2+2 等于多少？"            → DeepSeek        $0.27/M    节省 99%
"总结这篇文章"              → GPT-4o-mini     $0.60/M    节省 99%
"构建一个 React 组件"       → Claude Sonnet   $15.00/M   最佳平衡
"证明这个定理"              → DeepSeek-R      $0.42/M    推理型
"运行 50 个并行搜索"        → Kimi K2.5       $2.40/M    智能体集群
```

## 为什么选择 ClawRouter？

- **100% 本地路由** — 15 维加权评分在您的机器上运行，耗时 <1ms
- **零外部调用** — 路由决策从不进行 API 调用
- **30+ 模型** — 通过单一钱包访问 OpenAI、Anthropic、Google、DeepSeek、xAI、Moonshot
- **x402 小额支付** — 使用 Base 链上的 USDC 按请求付费，无需 API 密钥
- **开源** — MIT 许可证，完全可审查的路由逻辑

---

## 快速开始（2 分钟）

```bash
# 1. 安装（默认启用智能路由）
curl -fsSL https://raw.githubusercontent.com/BlockRunAI/ClawRouter/main/scripts/reinstall.sh | bash

# 2. 用 Base 链上的 USDC 为钱包充值（安装时会显示地址）
# 5 美元足够进行数千次请求

# 3. 重启 OpenClaw 网关
openclaw gateway restart
```

完成！智能路由（`blockrun/auto`）现在是您的默认模型。

### 使用技巧

- **使用 `/model blockrun/auto`** 在任何对话中随时切换
- **免费层级？** 使用 `/model free` — 路由到 gpt-oss-120b，完全免费
- **模型别名：** `/model sonnet`、`/model grok`、`/model deepseek`、`/model kimi`
- **想要特定模型？** 使用 `blockrun/openai/gpt-4o` 或 `blockrun/anthropic/claude-sonnet-4`
- **已有充值钱包？** `export BLOCKRUN_WALLET_KEY=0x...`

---

## 实际应用效果

<div align="center">
<img src="assets/telegram-demo.png" alt="通过 Telegram 使用 ClawRouter" width="500"/>
</div>

**流程：**

1. **自动生成钱包** 在 Base (L2) 上 — 安全保存在 `~/.openclaw/blockrun/wallet.key`
2. **充值 1 美元 USDC** — 足够进行数百次请求
3. **请求任何模型** — "帮我调用 Grok 查看 @hosseeb 对 AI 代理的看法"
4. **ClawRouter 自动路由** — 通过 `xai/grok-3` 生成 Grok 子代理，按请求付费

无需 API 密钥。无需账户。充值即可使用。

---

## 路由工作原理

**100% 本地运行，<1ms，零 API 调用。**

```
请求 → 加权评分器（15 个维度）
           │
           ├── 高置信度 → 从层级中选择模型 → 完成
           │
           └── 低置信度 → 默认使用 MEDIUM 层级 → 完成
```

没有外部分类器调用。模糊查询默认使用 MEDIUM 层级（DeepSeek/GPT-4o-mini）——快速、便宜，对大多数任务足够好。

**深入了解：** [15 维评分权重](docs/configuration.md#scoring-weights) | [架构设计](docs/architecture.md)

### 层级 → 模型映射

| 层级      | 主要模型              | 成本/M | 相比 Opus 节省 |
| --------- | --------------------- | ------ | -------------- |
| SIMPLE    | gemini-2.5-flash      | $0.60  | **99.2%**      |
| MEDIUM    | grok-code-fast-1      | $1.50  | **98.0%**      |
| COMPLEX   | gemini-2.5-pro        | $10.00 | **86.7%**      |
| REASONING | grok-4-fast-reasoning | $0.50  | **99.3%**      |

特殊规则：2+ 个推理标记 → REASONING 层级，置信度 0.97。

### 高级功能

ClawRouter v0.5+ 包含自动工作的智能功能：

- **智能体自动检测** — 将多步任务路由到 Kimi K2.5
- **工具检测** — 当存在 `tools` 数组时自动切换
- **上下文感知** — 过滤无法处理您上下文大小的模型
- **模型别名** — `/model free`、`/model sonnet`、`/model grok`
- **会话持久化** — 为多轮对话固定模型
- **免费层级回退** — 钱包为空时继续工作

**完整详情：** [docs/features.md](docs/features.md)

### 成本节省

| 层级         | 流量占比 | 成本/M      |
| ------------ | -------- | ----------- |
| SIMPLE       | ~45%     | $0.27       |
| MEDIUM       | ~35%     | $0.60       |
| COMPLEX      | ~15%     | $15.00      |
| REASONING    | ~5%      | $10.00      |
| **混合平均** |          | **$3.17/M** |

相比 Claude Opus 的 **$75/M** = 典型工作负载节省 **96%**。

---

## 支持的模型

30+ 模型来自 6 个提供商，一个钱包即可访问：

| 模型                  | 输入 $/M | 输出 $/M | 上下文 | 推理型 |
| --------------------- | -------- | -------- | ------ | :----: |
| **OpenAI**            |          |          |        |        |
| gpt-5.2               | $1.75    | $14.00   | 400K   |   \*   |
| gpt-4o                | $2.50    | $10.00   | 128K   |        |
| gpt-4o-mini           | $0.15    | $0.60    | 128K   |        |
| gpt-oss-120b          | **$0**   | **$0**   | 128K   |        |
| o3                    | $2.00    | $8.00    | 200K   |   \*   |
| o3-mini               | $1.10    | $4.40    | 128K   |   \*   |
| **Anthropic**         |          |          |        |        |
| claude-opus-4.5       | $5.00    | $25.00   | 200K   |   \*   |
| claude-sonnet-4       | $3.00    | $15.00   | 200K   |   \*   |
| claude-haiku-4.5      | $1.00    | $5.00    | 200K   |        |
| **Google**            |          |          |        |        |
| gemini-2.5-pro        | $1.25    | $10.00   | 1M     |   \*   |
| gemini-2.5-flash      | $0.15    | $0.60    | 1M     |        |
| **DeepSeek**          |          |          |        |        |
| deepseek-chat         | $0.14    | $0.28    | 128K   |        |
| deepseek-reasoner     | $0.55    | $2.19    | 128K   |   \*   |
| **xAI**               |          |          |        |        |
| grok-3                | $3.00    | $15.00   | 131K   |   \*   |
| grok-3-mini           | $0.30    | $0.50    | 131K   |        |
| grok-4-fast-reasoning | $0.20    | $0.50    | 131K   |   \*   |
| grok-4-fast           | $0.20    | $0.50    | 131K   |        |
| grok-code-fast-1      | $0.20    | $1.50    | 131K   |        |
| **Moonshot**          |          |          |        |        |
| kimi-k2.5             | $0.50    | $2.40    | 262K   |   \*   |

> **免费层级：** `gpt-oss-120b` 完全免费，当钱包为空时作为自动回退。

完整列表：[`src/models.ts`](src/models.ts)

### Kimi K2.5：智能体工作流

[Moonshot AI](https://kimi.ai) 的 Kimi K2.5 针对智能体集群和多步工作流进行了优化：

- **智能体集群** — 协调多达 100 个并行代理，执行速度快 4.5 倍
- **扩展工具链** — 在 200-300 次顺序工具调用中保持稳定，无漂移
- **视觉到代码** — 从 UI 模型和视频生成生产级 React 代码
- **成本高效** — 在智能体基准测试中比 Claude Opus 便宜 76%

最佳用途：并行网络研究、多代理编排、长时间运行的自动化任务。

---

## 项目架构

```
/Volumes/NVME/ClawRouter/
├── src/                        # 源代码（19 个文件）
│   ├── index.ts               # 插件入口点，OpenClaw 集成
│   ├── proxy.ts               # HTTP 代理服务器，请求处理，SSE 流
│   ├── provider.ts            # OpenClaw 提供商注册
│   ├── models.ts              # 30+ 模型定义和价格
│   ├── auth.ts                # 钱包密钥解析
│   ├── x402.ts                # EIP-712 支付签名，x402 协议
│   ├── balance.ts             # Base L2 上的 USDC 余额监控
│   ├── dedup.ts               # 请求去重（SHA-256 缓存）
│   ├── payment-cache.ts       # 预授权缓存
│   ├── logger.ts              # JSON 使用日志记录到磁盘
│   ├── errors.ts              # 自定义错误类型
│   ├── retry.ts               # 带指数退避的获取重试
│   ├── stats.ts               # 成本跟踪和统计
│   ├── session.ts             # 多轮对话的会话持久化
│   ├── types.ts               # TypeScript 类型定义
│   ├── version.ts             # 版本常量
│   └── router/                # 路由器子目录
│       ├── index.ts           # route() 入口点
│       ├── rules.ts           # 15 维加权评分器
│       ├── selector.ts        # 层级 → 模型选择 + 回退链
│       ├── config.ts          # 默认路由配置
│       ├── types.ts           # 路由器类型定义
│       └── llm-classifier.ts  # 基于 LLM 的分类（可选）
├── docs/                       # 文档目录
│   ├── architecture.md        # 技术架构深入解析
│   ├── configuration.md       # 配置参考
│   ├── features.md            # 功能文档
│   ├── troubleshooting.md     # 故障排除指南
│   ├── weight-scoring.md      # 评分算法详情
│   └── subscription-failover.md # 故障转移行为
├── test/                       # 测试套件（16 个测试文件）
├── scripts/                    # 安装脚本
│   ├── reinstall.sh           # 重新安装脚本
│   └── uninstall.sh           # 卸载脚本
├── assets/                     # 静态资源（横幅、演示图片）
├── skills/                     # 技能定义
├── package.json               # NPM 包配置
├── tsconfig.json              # TypeScript 配置
├── tsup.config.ts             # 构建配置
├── eslint.config.js           # ESLint 配置
├── openclaw.plugin.json       # OpenClaw 插件清单
└── README.md                  # 主文档
```

### 核心架构

```
┌─────────────────────────────────────────────────────────────┐
│                     您的应用程序                             │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                   ClawRouter (本地主机)                      │
│  ┌─────────────────┐  ┌─────────────────┐  ┌─────────────┐ │
│  │   加权评分器    │→ │   模型选择器    │→ │  x402 签名器│ │
│  │  (15 个维度)   │  │  (最便宜层级)   │  │   (USDC)    │ │
│  └─────────────────┘  └─────────────────┘  └─────────────┘ │
└─────────────────────────────────────────────────────────────┘
                              │
                              ▼
┌─────────────────────────────────────────────────────────────┐
│                      BlockRun API                            │
│    → OpenAI | Anthropic | Google | DeepSeek | xAI | Moonshot│
└─────────────────────────────────────────────────────────────┘
```

路由是**客户端**的——开源且可审查。

**深入了解：** [docs/architecture.md](docs/architecture.md) — 请求流程、支付系统、优化

---

## 技术栈

| 类别         | 详情                        |
| ------------ | --------------------------- |
| **语言**     | TypeScript 5.7              |
| **运行时**   | Node.js >=20                |
| **模块系统** | ES Modules (ESNext)         |
| **框架**     | OpenClaw 插件               |
| **构建工具** | tsup                        |
| **区块链**   | viem（用于 USDC/Base 交互） |
| **支付协议** | x402 小额支付               |

---

## 支付方式

无需账户。无需 API 密钥。**支付即认证** 通过 [x402](https://x402.org)。

```
请求 → 402（价格：$0.003）→ 钱包签名 USDC → 重试 → 响应
```

USDC 一直保留在您的钱包中直到使用 — 非托管。价格在签名前通过 402 头部可见。

**为钱包充值：**

- Coinbase：购买 USDC，发送到 Base
- 桥接：将 USDC 从任何链桥接到 Base
- 交易所：将 USDC 提现到 Base 网络

---

## 钱包配置

ClawRouter 自动生成并保存钱包到 `~/.openclaw/blockrun/wallet.key`。

```bash
# 检查钱包状态
/wallet

# 使用您自己的钱包
export BLOCKRUN_WALLET_KEY=0x...
```

**完整参考：** [钱包配置](docs/configuration.md#wallet-configuration) | [备份与恢复](docs/configuration.md#wallet-backup--recovery)

---

## 配置选项

基本使用无需配置。高级选项：

| 设置                  | 默认值   | 描述         |
| --------------------- | -------- | ------------ |
| `CLAWROUTER_DISABLED` | `false`  | 禁用智能路由 |
| `BLOCKRUN_PROXY_PORT` | `8402`   | 代理端口     |
| `BLOCKRUN_WALLET_KEY` | 自动生成 | 钱包私钥     |

**完整参考：** [docs/configuration.md](docs/configuration.md)

---

## 程序化使用

直接在代码中使用 ClawRouter：

```typescript
import { startProxy, route } from "@blockrun/clawrouter";

// 启动代理服务器
const proxy = await startProxy({ walletKey: "0x..." });

// 或直接（无代理）
const decision = route("证明 sqrt(2) 是无理数", ...);
```

**完整示例：** [docs/configuration.md#programmatic-usage](docs/configuration.md#programmatic-usage)

---

## 性能优化（v0.3）

- **SSE 心跳**：立即发送头部 + 心跳，防止上游超时
- **响应去重**：SHA-256 哈希 → 30s 缓存，防止重试时重复收费
- **支付预授权**：缓存 402 参数，预签名 USDC，跳过 402 往返（节省 ~200ms）

---

## 成本跟踪

在任何 OpenClaw 对话中使用 `/stats` 跟踪您的节省。

**完整详情：** [docs/features.md#cost-tracking-with-stats](docs/features.md#cost-tracking-with-stats)

---

## 为什么不是 OpenRouter / LiteLLM？

它们是为开发者构建的。ClawRouter 是为**智能体**构建的。

|          | OpenRouter / LiteLLM | ClawRouter           |
| -------- | -------------------- | -------------------- |
| **设置** | 人工创建账户         | 智能体生成钱包       |
| **认证** | API 密钥（共享密钥） | 钱包签名（加密）     |
| **支付** | 预付余额（托管）     | 按请求付费（非托管） |
| **路由** | 专有/封闭            | 开源，客户端         |

智能体不应该需要人工粘贴 API 密钥。它们应该生成钱包、接收资金、按请求付费——程序化地完成。

---

## 故障排除

快速检查清单：

```bash
# 检查版本（应为 0.5.7+）
cat ~/.openclaw/extensions/clawrouter/package.json | grep version

# 检查代理是否运行
curl http://localhost:8402/health
```

**完整指南：** [docs/troubleshooting.md](docs/troubleshooting.md)

---

## 开发

```bash
git clone https://github.com/BlockRunAI/ClawRouter.git
cd ClawRouter
npm install
npm run build
npm run typecheck

# 端到端测试（需要充值钱包）
BLOCKRUN_WALLET_KEY=0x... npx tsx test-e2e.ts
```

### 可用脚本

| 命令                            | 描述                   |
| ------------------------------- | ---------------------- |
| `npm run build`                 | 构建项目               |
| `npm run dev`                   | 开发模式（监视）       |
| `npm run typecheck`             | TypeScript 类型检查    |
| `npm run lint`                  | ESLint 代码检查        |
| `npm run format`                | Prettier 格式化        |
| `npm run test:resilience:quick` | 快速弹性测试           |
| `npm run test:resilience:full`  | 完整弹性测试（4 小时） |

---

## 路由层级说明

| 层级      | 主要模型              | 成本/M | 适用场景      |
| --------- | --------------------- | ------ | ------------- |
| SIMPLE    | gemini-2.5-flash      | $0.60  | 基础查询      |
| MEDIUM    | grok-code-fast-1      | $1.50  | 一般任务      |
| COMPLEX   | gemini-2.5-pro        | $10.00 | 复杂推理      |
| REASONING | grok-4-fast-reasoning | $0.50  | 数学/逻辑证明 |

---

## 路线图

- [x] 智能路由 — 15 维加权评分，4 层级模型选择
- [x] x402 支付 — 按请求 USDC 小额支付，非托管
- [x] 响应去重 — 防止重试时重复收费
- [x] 支付预授权 — 跳过 402 往返
- [x] SSE 心跳 — 防止上游超时
- [x] 智能体自动检测 — 多步任务自动切换到智能体模型
- [x] 工具检测 — 存在 tools 数组时自动切换到智能体模式
- [x] 上下文感知路由 — 过滤无法处理上下文大小的模型
- [x] 会话持久化 — 为多轮对话固定模型
- [x] 成本跟踪 — /stats 命令和节省仪表板
- [x] 模型别名 — `/model free`、`/model sonnet`、`/model grok` 等
- [x] 免费层级 — 钱包为空时 gpt-oss-120b 免费使用
- [ ] 级联路由 — 先尝试便宜模型，质量低时升级
- [ ] 支出控制 — 每日/每月预算
- [ ] 远程分析 — 在 blockrun.ai 进行成本跟踪

---

## 许可证

MIT

---

<div align="center">

**[BlockRun](https://blockrun.ai)** — 按请求付费的 AI 基础设施

如果 ClawRouter 为您节省了资金，请考虑给仓库点个星。

</div>
