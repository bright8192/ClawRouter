# 权重打分与路由分层说明

本文档说明 ClawRouter 如何通过 **15 维加权打分** 将请求分类到四个 tier（SIMPLE / MEDIUM / COMPLEX / REASONING），并据此选择模型。实现位于 `src/router/rules.ts` 与 `src/router/config.ts`。

---

## 1. 概述

- **输入**：用户 prompt、可选 systemPrompt、估计 token 数。
- **输出**：`ScoringResult` — 加权总分 `score`、建议 tier、置信度 `confidence`、信号列表 `signals`、agentic 分数 `agenticScore`。
- **流程**：对 15 个维度分别打分（多为 [-1, 1] 或 [0, 1]），按配置权重求和得到 `weightedScore`，再根据 `tierBoundaries` 映射到 tier；用与最近边界的距离经 sigmoid 得到置信度；置信度不足则返回 `tier: null`，由上层使用 `ambiguousDefaultTier`。

---

## 2. 十五个维度详解

### 2.1 维度总览

| 维度名 | 权重 | 分数范围 | 检测方式 |
|--------|------|----------|----------|
| reasoningMarkers | 0.18 | 0 / 0.7 / 1.0 | 用户 prompt 关键词匹配（低 1 / 高 2） |
| codePresence | 0.15 | 0 / 0.5 / 1.0 | 全文关键词（低 1 / 高 2） |
| multiStepPatterns | 0.12 | 0 / 0.5 | 正则：first…then、step N、N. |
| technicalTerms | 0.10 | 0 / 0.5 / 1.0 | 技术词（低 2 / 高 4） |
| tokenCount | 0.08 | -1 / 0 / 1 | 短(&lt;50) / 中 / 长(&gt;500) token |
| creativeMarkers | 0.05 | 0 / 0.5 / 0.7 | 创意类关键词（低 1 / 高 2） |
| questionComplexity | 0.05 | 0 / 0.5 | 问号个数 &gt; 3 |
| constraintCount | 0.04 | 0 / 0.3 / 0.7 | 约束类词（低 1 / 高 3） |
| agenticTask | 0.04 | 0 / 0.2 / 0.6 / 1.0 | agentic 关键词数量（1–2 / 3 / 4+） |
| imperativeVerbs | 0.03 | 0 / 0.3 / 0.5 | 祈使动词（低 1 / 高 2） |
| outputFormat | 0.03 | 0 / 0.4 / 0.7 | 输出格式词（低 1 / 高 2） |
| simpleIndicators | 0.02 | 0 / -1.0 | 简单问句词（低 1 / 高 2 均为 -1） |
| domainSpecificity | 0.02 | 0 / 0.5 / 0.8 | 领域专有词（低 1 / 高 2） |
| referenceComplexity | 0.02 | 0 / 0.3 / 0.5 | 引用/文档词（低 1 / 高 2） |
| negationComplexity | 0.01 | 0 / 0.3 / 0.5 | 否定词（低 2 / 高 3） |

权重和 = 1.0。权重在 `config.scoring.dimensionWeights` 中配置。

---

### 2.2 各维度检测逻辑与关键词概要

#### tokenCount（0.08）

- **逻辑**：基于估计 token 数（字符数/4）。
- **阈值**：`tokenCountThresholds.simple = 50`，`complex = 500`。
- **分数**：&lt; 50 → -1（偏简单）；&gt; 500 → 1（偏复杂）；否则 0。

#### codePresence（0.15）

- **逻辑**：在 **全文**（systemPrompt + prompt）中匹配代码相关关键词。
- **阈值**：低 1 个、高 2 个。
- **分数**：0 → 0.5 → 1.0。
- **关键词示例**：function, class, import, def, async, await, const, ```，以及中文/日/俄/德对应词（函数、クラス、функция 等）。完整列表见 `config.scoring.codeKeywords`。

#### reasoningMarkers（0.18）

- **逻辑**：仅在 **用户 prompt** 中匹配，避免 system 里的 “step by step” 误触。
- **阈值**：低 1 个、高 2 个。
- **分数**：0 → 0.7 → 1.0。
- **关键词示例**：prove, theorem, step by step, chain of thought, 证明、逐步、論理的 等。完整列表见 `config.scoring.reasoningKeywords`。
- **特殊**：若用户 prompt 中 reasoning 关键词 ≥ 2，会触发 **推理覆盖**，直接返回 REASONING tier（见后文）。

#### technicalTerms（0.10）

- **逻辑**：全文匹配技术词。
- **阈值**：低 2 个、高 4 个。
- **分数**：0 → 0.5 → 1.0。
- **关键词示例**：algorithm, kubernetes, distributed, 算法、架构、分布式、マイクロサービス 等。见 `config.scoring.technicalKeywords`。

#### creativeMarkers（0.05）

- **逻辑**：全文匹配创意/写作类词。
- **阈值**：低 1、高 2。
- **分数**：0 → 0.5 → 0.7。
- **关键词示例**：story, poem, brainstorm, 故事、创作、想像 等。见 `config.scoring.creativeKeywords`。

#### simpleIndicators（0.02）

- **逻辑**：全文匹配简单问句/查词类词。
- **阈值**：低 1、高 2。
- **分数**：无匹配 0；有匹配均为 **-1.0**（拉低总分，偏 SIMPLE）。见 `config.scoring.simpleKeywords`（what is, define, translate, 什么是、定义、翻译 等）。

#### multiStepPatterns（0.12）

- **逻辑**：正则检测多步表述，不依赖关键词表。
- **模式**：`/first.*then/i`、`/step \d/i`、`/\d\.\s/`。
- **分数**：任一命中 → 0.5；否则 0。

#### questionComplexity（0.05）

- **逻辑**：统计用户 prompt 中 `?` 个数。
- **分数**：&gt; 3 个问号 → 0.5；否则 0。

#### imperativeVerbs（0.03）

- **逻辑**：全文匹配祈使/动作类动词。
- **阈值**：低 1、高 2。
- **分数**：0 → 0.3 → 0.5。
- **关键词示例**：build, create, implement, deploy, 构建、创建、实现、部署 等。见 `config.scoring.imperativeVerbs`。

#### constraintCount（0.04）

- **逻辑**：全文匹配约束/限制类词。
- **阈值**：低 1、高 3。
- **分数**：0 → 0.3 → 0.7。
- **关键词示例**：at most, O(, maximum, 不超过、最大、限制 等。见 `config.scoring.constraintIndicators`。

#### outputFormat（0.03）

- **逻辑**：全文匹配输出格式/结构化词。
- **阈值**：低 1、高 2。
- **分数**：0 → 0.4 → 0.7。
- **关键词示例**：json, yaml, schema, structured, 表格、结构化 等。见 `config.scoring.outputFormatKeywords`。

#### referenceComplexity（0.02）

- **逻辑**：全文匹配引用/文档/上下文词。
- **阈值**：低 1、高 2。
- **分数**：0 → 0.3 → 0.5。
- **关键词示例**：above, the docs, the api, 上面、文档、代码 等。见 `config.scoring.referenceKeywords`。

#### negationComplexity（0.01）

- **逻辑**：全文匹配否定/排除类词。
- **阈值**：低 2、高 3。
- **分数**：0 → 0.3 → 0.5。
- **关键词示例**：don't, avoid, without, 不要、避免、没有 等。见 `config.scoring.negationKeywords`。

#### domainSpecificity（0.02）

- **逻辑**：全文匹配强领域词。
- **阈值**：低 1、高 2。
- **分数**：0 → 0.5 → 0.8。
- **关键词示例**：quantum, fpga, genomics, zero-knowledge, 量子、基因组学、格密码 等。见 `config.scoring.domainSpecificKeywords`。

#### agenticTask（0.04）

- **逻辑**：全文匹配 agentic 任务词（文件、执行、多步、迭代）。
- **分数**：0 → 0.2（1–2 个）→ 0.6（3 个）→ 1.0（4+ 个）。同时产出 **agenticScore**（0 / 0.2 / 0.6 / 1.0）供上层决定是否使用 agenticTiers。
- **关键词示例**：read file, edit, execute, deploy, step 1, fix, debug, verify, 读取文件、执行、部署、修复、验证 等。见 `config.scoring.agenticTaskKeywords`。

---

## 3. 加权总分计算

```text
weightedScore = Σ (dimensionScore[d] × dimensionWeights[d.name])
```

- 未在 `dimensionWeights` 中列出的维度按权重 0 处理。
- 总分大致落在 [-0.3, 0.4] 区间，用于与 tier 边界比较。

---

## 4. Tier 边界与分层映射

配置项：`config.scoring.tierBoundaries`（默认在 `config.ts`）：

| 边界名 | 默认值 | 含义 |
|--------|--------|------|
| simpleMedium | 0.0 | SIMPLE / MEDIUM 分界 |
| mediumComplex | 0.18 | MEDIUM / COMPLEX 分界 |
| complexReasoning | 0.4 | COMPLEX / REASONING 分界 |

映射规则（`rules.ts`）：

- `weightedScore < simpleMedium` → **SIMPLE**
- `simpleMedium ≤ weightedScore < mediumComplex` → **MEDIUM**
- `mediumComplex ≤ weightedScore < complexReasoning` → **COMPLEX**
- `weightedScore ≥ complexReasoning` → **REASONING**

---

## 5. 置信度与歧义处理

- **距离**：当前 tier 与最近边界的距离 `distanceFromBoundary`（例如在 MEDIUM 内则为到 0 或 0.18 的较小距离）。
- **sigmoid 校准**：`confidence = 1 / (1 + exp(-confidenceSteepness * distanceFromBoundary))`，`confidenceSteepness` 默认 12。
- **歧义**：若 `confidence < confidenceThreshold`（默认 0.7），则返回 `tier: null`，路由层使用 `overrides.ambiguousDefaultTier`（默认 MEDIUM）选模型。

---

## 6. 特殊覆盖规则（不经过边界比较）

### 6.1 推理覆盖（rules 内）

- **条件**：用户 prompt 中 `reasoningKeywords` 匹配数 ≥ 2。
- **效果**：直接返回 tier = **REASONING**，置信度至少 0.85，不再用 `tierBoundaries` 比较。

### 6.2 Agentic 模型集（index 内）

- **条件**：`agenticScore >= 0.6` 或 `overrides.agenticMode === true`，且配置了 `agenticTiers`。
- **效果**：使用 `agenticTiers` 的 primary/fallback；否则使用 `tiers`。分层仍按同一套 weightedScore + tierBoundaries 得到，只是模型表不同。

### 6.3 大上下文覆盖（index 内）

- **条件**：估计 input token 数 &gt; `overrides.maxTokensForceComplex`（默认 100_000）。
- **效果**：强制 tier = **COMPLEX**，再按当前模型表（tiers 或 agenticTiers）选模型。

### 6.4 结构化输出最小 tier（index 内）

- **条件**：systemPrompt 匹配 `/json|structured|schema/i`，且当前 tier 低于 `overrides.structuredOutputMinTier`（默认 MEDIUM）。
- **效果**：将 tier 提升到 `structuredOutputMinTier`。

---

## 7. 配置入口一览

| 配置项 | 位置 | 说明 |
|--------|------|------|
| dimensionWeights | config.scoring.dimensionWeights | 15 维权重，建议和 1.0 |
| tierBoundaries | config.scoring.tierBoundaries | 三个边界值 |
| confidenceSteepness | config.scoring.confidenceSteepness | sigmoid 陡峭度，默认 12 |
| confidenceThreshold | config.scoring.confidenceThreshold | 歧义阈值，默认 0.7 |
| tokenCountThresholds | config.scoring.tokenCountThresholds | simple / complex token 数 |
| 各 *Keywords 列表 | config.scoring.* | 各维度关键词，支持多语言 |
| ambiguousDefaultTier | config.overrides.ambiguousDefaultTier | 歧义时默认 tier |
| structuredOutputMinTier | config.overrides.structuredOutputMinTier | 结构化输出最低 tier |
| maxTokensForceComplex | config.overrides.maxTokensForceComplex | 超长上下文强制 COMPLEX |
| agenticMode | config.overrides.agenticMode | 是否强制使用 agenticTiers |

通过 openclaw 的 `routing.scoring` / `routing.overrides` 等可覆盖上述默认值，详见 `docs/configuration.md`。

---

## 8. 流程简图

```text
prompt + systemPrompt + estimatedTokens
         │
         ▼
┌─────────────────────────────────────────┐
│  classifyByRules()                       │
│  • 15 维打分 → weightedScore             │
│  • reasoning 关键词 ≥ 2 → 直接 REASONING  │
│  • 否则按 tierBoundaries 得 tier          │
│  • 距离 → sigmoid → confidence           │
│  • confidence < 0.7 → tier = null        │
└─────────────────────────────────────────┘
         │
         ▼
┌─────────────────────────────────────────┐
│  route()                                 │
│  • agenticScore ≥ 0.6 或 agenticMode     │
│    → 使用 agenticTiers，否则 tiers        │
│  • token 超 maxTokensForceComplex        │
│    → 强制 COMPLEX                         │
│  • tier === null → ambiguousDefaultTier  │
│  • 结构化输出 → 不低于 structuredOutput   │
│    MinTier                               │
└─────────────────────────────────────────┘
         │
         ▼
selectModel(tier) → primary + fallback 链
```

---

## 9. 中文支持与调优

### 9.1 当前中文支持情况

| 方面 | 支持情况 | 说明 |
|------|----------|------|
| **关键词维度** | 较好 | 15 个维度中，除 `multiStepPatterns` 与 `questionComplexity` 外，其余均通过关键词表检测；`config.scoring` 里已为 **code / reasoning / simple / technical / creative / imperative / constraint / outputFormat / reference / negation / domainSpecific / agenticTask** 等列表加入了中文词（如 函数、证明、什么是、算法、构建、第一步、修复 等）。 |
| **多步模式 (multiStepPatterns)** | 偏英文 | 仅用正则：`/first.*then/i`、`/step \d/i`、`/\d\.\s/`。中文常见表述如「首先…然后」「第一步」「第一，」「1. 」未覆盖。 |
| **问号复杂度 (questionComplexity)** | 偏英文 | 只统计 ASCII `?`。中文常使用全角 `？`（U+FF1F）或不用问号（如「怎么才能」「如何做」），这些不会被计为多问句。 |
| **Token 估计** | 通用 | 使用 `字符数 / 4`，对中英文混合或纯中文可能偏低估（不少 tokenizer 下中文 1 字 ≈ 1 token）。 |
| **匹配方式** | 一致 | 所有关键词用 `text.includes(kw.toLowerCase())`，中文无大小写，匹配逻辑等价。 |

结论：**关键词类维度对中文已有较好覆盖；薄弱点主要在「多步模式」和「问号复杂度」两条规则，以及可选的 token 估计与中文专属表述。**

---

### 9.2 若中文支持欠佳，如何调优

#### 方式一：仅改配置（推荐先做）

通过 openclaw 的 `routing.scoring` 或直接改 `config.ts`，**扩充中文关键词**，不碰代码即可提升中文场景下的分数与 tier 准确性。

- **补全各维度中文词**（按业务语料收词）  
  - **reasoningKeywords**：如「推理」「步骤」「论证」「推导过程」「分步」「先…再…」。  
  - **simpleKeywords**：如「咋」「咋样」「怎么办」「如何」「为啥」「有没有」。  
  - **technicalKeywords**：如「并发」「缓存」「容器」「接口」「协议」「线程」。  
  - **agenticTaskKeywords**：已有「读取文件、查看、打开、编辑、执行、部署、第一步、第二步、修复、调试、确认、验证」等，可按需加「运行」「测试」「提交」「重试」「检查一下」。  
  - **imperativeVerbs**：如「写一个」「改一下」「跑一遍」「发给我」。  
  - **constraintIndicators**：如「不能超过」「必须」「只能」「时间复杂度」「空间复杂度」。  
  - **outputFormatKeywords**：如「输出为」「写成」「按…格式」「返回 json」。  
  - **referenceKeywords**：如「根据上文」「参考文档」「结合代码」「如上」「如下」。

- **微调边界与权重（可选）**  
  - 若观察到中文请求普遍被分得过轻：可适当**提高** `reasoningMarkers`、`codePresence`、`technicalTerms` 等权重，或**略降** `tierBoundaries.mediumComplex` / `complexReasoning`（例如 0.18→0.16、0.4→0.35），使同分数更容易进 MEDIUM/COMPLEX。  
  - 若中文简单问句被误判为复杂：可给 `simpleKeywords` 增加更多中文口语表述，并确认 `simpleIndicators` 权重不为 0。

- **歧义与默认 tier**  
  - 中文歧义请求（`tier: null`）会走 `overrides.ambiguousDefaultTier`（默认 MEDIUM）。若你希望中文为主场景更偏保守，可把 `ambiguousDefaultTier` 设为 `SIMPLE`；若更偏能力可设为 `COMPLEX`。

以上均在 `config.scoring` / `config.overrides` 中完成，详见本文档 §7 配置入口。

---

#### 方式二：改代码以增强中文规则

当仅靠关键词仍不够时，可在 `src/router/rules.ts` 中做小范围扩展，使 **multiStepPatterns** 和 **questionComplexity** 对中文更友好。

**1）多步模式 (multiStepPatterns)** — ✅ 已实现  
`src/router/rules.ts` 的 `scoreMultiStep` 已支持中文多步模式，正则包括：

- 英文：`/first.*then/i`、`/step \d+/i`、`/\d+[\.．]\s+/`
- 中文：`/第[一二三四五六七八九十\d]+步/`（第一步、第1步）、`/步骤\s*[一二三四五六七八九十\d]+/`（步骤1、步骤一）、`/首先[\s\S]{1,80}然后/`、`/第[一二三四五六七八九十\d]+[、,]\s*第[一二三四五六七八九十\d]+/`（第一、第二、）

**2）问号复杂度 (questionComplexity)** — ✅ 已实现  
`scoreQuestionComplexity` 已同时统计：

- 半角 `?` 与全角 `？`
- 无语符中文多问：当无显式问号且出现 2+ 次 `怎么|如何|怎样` 时计为多问句（如「怎么安装，怎么配置，怎么运行」）

**3）Token 估计（可选）**  
若希望纯中文/中英混合更准，可在 `route` 或调用 `classifyByRules` 前，对 `estimatedTokens` 做语言相关修正（例如检测到 CJK 字符比例高时用 `length * 0.6` 或接入简单 tokenizer 估计）。当前代码未区分语言，保持 `length/4` 也可接受，调优时再考虑。

实施方式二时，建议**先做 1 和 2**，发布前后用中文 prompt 回归一下 tier 与置信度；3 视需求再加。

---

### 9.3 调优检查清单

- [ ] 各维度中文关键词是否覆盖你业务中的常见说法（尤其是 reasoning、simple、technical、agentic）。  
- [ ] 多步/分步类中文（首先…然后、第一步、1. 2.）是否被识别：若未识别，考虑方式二之 multiStep 扩展。  
- [ ] 中文多问句是否被识别：若依赖「？」而语料多用「？」或无语符，考虑方式二之 questionComplexity。  
- [ ] 歧义时默认 tier 是否符合预期（`ambiguousDefaultTier`）。  
- [ ] 是否有大量简单中文问句被误判为复杂：若是，加强 simpleKeywords 并确认 simpleIndicators 权重。  
- [ ] 是否需要为中文单独微调 tier 边界或部分维度权重：若是，在 config 中调 `tierBoundaries` / `dimensionWeights`。

---

## 10. 相关代码文件

- **分类与加权**：`src/router/rules.ts`（`classifyByRules`、各 `score*`、`calibrateConfidence`）
- **默认权重与关键词**：`src/router/config.ts`（`scoring`、`tierBoundaries`、`dimensionWeights`）
- **类型**：`src/router/types.ts`（`ScoringConfig`、`ScoringResult`、`Tier`）
- **路由入口与覆盖**：`src/router/index.ts`（`route`、agentic/大上下文/结构化/歧义处理）
- **模型选择与回退链**：`src/router/selector.ts`（`selectModel`、`getFallbackChain`）
