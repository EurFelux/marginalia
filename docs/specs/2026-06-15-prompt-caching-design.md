# Prompt caching（按 provider 抽象）设计

> Status: 已实现（**事后补写**——实现先于 spec，已据实补齐）
> Source: 用户请求「研究 anthropic provider 怎么启用 prompt cache」+ 「不止 anthropic 需要 caching，要多一层抽象」
> Date: 2026-06-15

## 背景与问题

选区问 AI / 章节摘要等路径每次请求都把同一批稳定前缀（系统提示 + 工具定义 + 对话历史）重发给模型。这些前缀在一条会话里逐轮复用、在同书多会话间也大量重合，但每次都按全价重新计费、重新预填，徒增成本与首字延迟。

主流 LLM 都提供 prompt caching 来摊掉这笔重复开销，但**接入方式因 provider 而异**：

- **Claude 没有 implicit cache**——缓存是纯前缀匹配，必须由调用方**显式标记** `cache_control` 断点，否则一个 token 都不缓存。
- OpenAI / DeepSeek / Gemini 2.5 等是**隐式缓存**——服务端自动缓存长前缀，调用方无需做任何标记。

本项目同时支持四类 provider（`anthropic` / `openai-responses` / `openai-chat-completions` / `google-generate-content`），其中只有 Anthropic 家族需要显式断点。第一版实现把逻辑硬编码成「只认 anthropic」的 `if`，被指出**缺少 provider 抽象**：缓存策略应当可按 provider 插拔，而非写死一家。本设计补齐这层抽象。

## 目标 / 非目标

**目标**

- 为「显式断点型」provider（当前 Anthropic）按官方推荐布局插入前缀缓存断点，降低重复前缀的成本与首字延迟。
- 把「断点放哪」(provider 无关的布局策略) 与「断点怎么标」(provider 专属 marker) **解耦**，做成可注册的 per-provider 策略；新增显式断点型 provider 只需注册一行。
- 「隐式缓存型」provider 原样透传，不引入无谓改动。
- `runSend` / `runResend` 两条发送路径一处覆盖。
- 纯函数承载核心逻辑，可无头单测。

**非目标（明确排除，避免范围蔓延）**

- 不为隐式缓存型 provider（OpenAI / DeepSeek / Gemini）做任何事——它们服务端自动缓存。
- 不把易变的「会话概要（summary）」从 system 块中拆出（见 §6 已知局限）。
- 不缓存 agent 工具循环内逐步增长的 tool_use/tool_result（仅覆盖跨轮稳定前缀）。
- 不接 Gemini 的 explicit cachedContent API（与 per-message 断点是不同机制，超出本抽象范畴）。
- 不暴露缓存命中率的 UI/可观测面板（usage 里已有 cacheRead/cacheWrite，按需后续）。

## 关键约束与决策依据

### A. Claude 前缀缓存的硬规则（来自 Anthropic 官方语义）

- **无 implicit cache**，必须显式标 `cache_control: { type: 'ephemeral' }` 断点。
- **纯前缀逐字节匹配**：渲染序固定为 `tools → system → messages`；前缀里任何字节变化都让该位置之后的缓存全部失效。
- 每请求**最多 4 个断点**；有**最小可缓存前缀**（Sonnet 1024 / Haiku·Fable 2048 / Opus 4096 token），过短静默不缓存。
- 缓存读 ≈ 0.1× 输入价，写 ≈ 1.25×（5m TTL）；约两次请求回本。
- 断点回看窗口 **20 个 content block**：一轮里若新增 >20 个 block（长工具循环）可能漏命中。

### B. AI SDK 里 cacheControl 挂在消息上，不是调用级（实证 `@ai-sdk/anthropic` 3.0.81）

`providerOptions.anthropic.cacheControl` 必须放在 **message / message part / SystemModelMessage** 上；`streamText` 顶层的 `providerOptions`（本项目用于 openai-responses 的 `store:false`）是**调用级**，放缓存控制无效。anthropic provider 的 `getCacheControl` 读的正是消息上的 `providerOptions.anthropic.cacheControl`，再发成 API 的 `cache_control`。

### C. system 走 `system` 参数即可携带断点，无需塞进 messages

`streamText` 的 `system` 参数类型是 `string | SystemModelMessage | Array<SystemModelMessage>`（`ai` 6.0.193 类型注释明示：需要 caching 等 provider options 时传 `SystemModelMessage`）。

→ **决策**：system 仍走 `system` 参数，仅在需要时升级为带 `providerOptions` 的 `SystemModelMessage`。实证（`standardize-prompt.ts`）：`allowSystemInMessages` 警告**只在 `messages` 数组里出现 system 消息时触发**，`system` 参数单独校验、不触发——故无需把 system 挪进 messages，也无需开 `allowSystemInMessages`，blast radius 最小。

### D. provider 缓存语义分两类 → 需抽象（用户核心诉求）

| 类别       | provider                                                                                | 处理                               |
| ---------- | --------------------------------------------------------------------------------------- | ---------------------------------- |
| 显式断点型 | `anthropic`（含将来 Bedrock/Vertex 的 Anthropic 模型）                                  | 标 cache_control / cachePoint 断点 |
| 隐式型     | `openai-responses` / `openai-chat-completions`(含 DeepSeek) / `google-generate-content` | 服务端自动缓存，**透传**           |

→ 不能写死「只认 anthropic」。同一套断点**布局**对所有显式断点型通用，仅 **marker**（providerOptions 的键值）因 provider 而异——故按此切分抽象。

## 设计

### 1. 抽象：布局策略 + per-provider marker 注册表（`src/main/ai/prompt-caching.ts`，纯函数）

- `breakpointStrategy(marker): CachingStrategy`——**provider 无关**的共享布局工厂。给定 `marker`（provider 专属 providerOptions），返回一个把断点按统一布局插入 system + messages 的策略。
- `STRATEGIES: Partial<Record<AiProviderApiType, CachingStrategy>>`——provider → 策略注册表。当前仅 `anthropic: breakpointStrategy({ anthropic: { cacheControl: { type: 'ephemeral' } } })`。**新增显式断点型 provider 在此加一行**（如 Bedrock：`breakpointStrategy({ bedrock: { cachePoint: { type: 'default' } } })`）。
- `withPromptCaching(input): CachingResult`——入口。按 `providerType` 查表派发；查不到（隐式型 / undefined）则原样返回。

### 2. 断点布局（官方推荐：system 固定 + 末两轮滚动）

- **system 固定断点**：升级 system 为 `SystemModelMessage` 带 marker。因渲染序 `tools→system`，此断点**连工具定义一起进缓存**，跨轮、（base prompt 相同时）跨会话复用。
- **末两个 user 轮各一个滚动断点**：随对话增长滚动。打**两个**而非一个，是为配合 20-block lookback——即便最末轮因新增 block 过多未命中，前一轮仍能命中，且让上一轮写入的缓存能被本轮读到。
- 合计 ≤3 断点，在 4 上限内。
- 不可变：复制 messages 数组，不改调用方入参。

### 3. TTL = 5 分钟 ephemeral

默认 `{ type: 'ephemeral' }`（5m）。1h TTL 写入翻倍（2×）、需 3 次以上请求回本，仅适合长间隔 bursty 流量——非默认，留作后续按需。

### 4. 接线点（`src/main/ai/stream-assistant.ts`）

在 `streamAssistantReply` 调 `streamText` 之前调用 `withPromptCaching({ providerType: resolved.providerType, system: systemPrompt, messages })`，用返回的 `system` / `messages` 喂 `streamText`。`runSend` / `runResend` 都汇入此函数，故一处覆盖两路。顶层 `providerOptions`（openai store:false）保持不变、与缓存正交。

## 验证

- **纯函数单测** `prompt-caching.test.ts`：`breakpointStrategy` 用任意 marker 证明布局与 marker 内容无关（system 标记 / 末两轮 / 单轮 / 无 system / 不可变）；`withPromptCaching` 证明 anthropic 应用 ephemeral、三类隐式 provider + undefined 全透传。
- **wiring 测试** `send.test.ts`：经真实 AI SDK 标准化后捕获 `LanguageModelV3` prompt，断言 anthropic 路径 system + 末轮 user 带 `cacheControl: { type: 'ephemeral' }`、openai-responses 不带。证明断点真的穿到了发给 provider 的请求体。
- 核对 `@ai-sdk/anthropic` dist 的 `getCacheControl`（读 `providerOptions.anthropic.cacheControl`）确认真 provider 会发出 `cache_control`。
- `pnpm typecheck` / `pnpm lint` / 上述测试全绿。
- **未做**：未真打一次 Anthropic API 看 `usage.cache_read_input_tokens`（需真 key + GUI，本会话外）。

## 已知局限与后续

- **summary 拼在 system 块内**（`assemblePrompt` 把会话概要并入 system 消息）：概要 per-conversation 且压缩时会变，故 system 固定断点**跨会话复用打折**、且**每次压缩失效一次**（单会话多轮内仍有效）。后续可把「稳定 base prompt」与「易变 summary」拆成两个 system 块、断点只打前者后面，以榨满跨会话复用——属独立优化，需另出 spec。
- 工具循环内逐步增长的 tool_use/tool_result 未单独打断点（标准跨轮模式范畴）。

## 文件清单

| 文件                                 | 改动                                                            |
| ------------------------------------ | --------------------------------------------------------------- |
| `src/main/ai/prompt-caching.ts`      | 新增：`breakpointStrategy` + `STRATEGIES` + `withPromptCaching` |
| `src/main/ai/prompt-caching.test.ts` | 新增：纯函数单测                                                |
| `src/main/ai/stream-assistant.ts`    | 接线：`streamText` 前调 `withPromptCaching`                     |
| `src/main/ai/send.test.ts`           | 新增：anthropic / 非 anthropic wiring 测试                      |
