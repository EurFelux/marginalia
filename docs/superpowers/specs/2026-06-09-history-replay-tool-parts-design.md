# Marginalia · 历史回放 assistant 工具/推理 part（textOfParts → 结构化回放）设计文档

> 状态：设计已确认（用户认可方案，spec 待用户审阅 → 落实施计划）
> 日期：2026-06-09
> 轨道：AI 会话质量——把历史回放从「assistant 轮只取 text」升级为「原生结构化回放真实 tool-call / tool-result」，根治模型从被篡改历史里**少样本误学**出的「假装调用工具」。
> 需求：GitHub Issue [#42](https://github.com/EurFelux/marginalia/issues/42)（`debt` · `area:ai` · 现 P2）。经 2026-06-09 用户复现，本质是 UX bug 而非纯工程债——**建议升 P1、并考虑 `debt → bug` 改标**（待用户点头后改看板）。
> 上游：本项是 [#64](https://github.com/EurFelux/marginalia/issues/64)（会话上下文管理）spec **明确缓办、单独追踪**的「改模型行为」项（见其 §0/§1/§6/§9）；取证记忆 `ai-toolcall-failure-is-model-behavior`。

---

## 0. 问题陈述（取证结论）

`stream-assistant.ts` 的 `toUIMessageStream` `onFinish` 把 **`responseMessage.parts` 整体落库**（text + tool-call + tool-result + reasoning 全在，`stream-assistant.ts:110-120`）。但回放时 `assemblePrompt → renderHistoryMessage → textOfParts`（`prompt.ts:21-25, 56-60, 117-125`）对 assistant 轮**只取 `type==="text"`**，tool-call / tool-result / reasoning 全部丢弃，且每条历史消息被压成**纯字符串 `content`**。

**后果（用户 2026-06-09 复现）**：历史里的 assistant 轮被抹成「**没调任何工具就直接说出了章节内容**」的纯散文。模型把**自己被篡改过的历史**当少样本范例照着学，习得错误模式——「我可以不真调工具、直接编造读过的内容」，于是开始**假装调用工具**（输出像是工具派生、实则无任何真实 `tool-call` 的自信答案），会话越长、被回放的假范例越多，跑偏越狠。这与 #64 取证的「124 条会话退化成纯闲聊、幻觉谎称已调」同源。

**关键认识**：数据没丢——是**回放口径**丢的。改动收敛在**装配层（prompt.ts）**，不动存储、不动渲染。

## 1. 目标与非目标

**目标**：

- assistant 历史轮以**原生结构化**回放真实 `tool-call` / `tool-result` 消息对，让模型重新看到「**先真调工具 → 拿到结果 → 再回答**」的正确范式，消除「假装调用」的少样本污染。
- 保持 `assemblePrompt` **纯函数**（不碰 Electron/DB，headless vitest 可裸测——CLAUDE.md「纯业务函数 + 胶水层注入」命脉）。

**非目标（落实施时严守）**：

- **不回放跨轮 reasoning**（决策①，显式砍掉；理由见 §5）。
- **不碰单轮内 agent 循环的 reasoning**——streamText 内部多步 think→tool→think 的 reasoning 连贯性由 SDK 自管，本改动**根本不触及**（边界见 §5）。
- **不改消息持久化**：reasoning / tool part 仍**整体存库**供 UI 显示与真相留存（「ModelMessage 按需派生、不持久化」哲学不变）。
- **不动 compaction 转写**：`renderFoldedTranscript` / `renderHistoryMessage` 保持纯文本口径（决策②，理由见 §6）。
- **不逐字回放 image tool-result**：`readPage` image 整页 PNG 用短文本占位（决策已定）。
- **不改 user 轮渲染**：chips→sections 同构渲染照旧（`renderUserTurn` 不动）。
- 不引入新 IPC / schema / DB 列。

## 2. 方案对比

| 方案                          | 做法                                                                                                                                                                   | 取舍                                                                                                    |
| ----------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| **A（采纳）原生结构化回放**   | history 循环里 assistant 轮走 `convertToModelMessages([{role,parts}], {ignoreIncompleteToolCalls:true})`，产出真实 `assistant(text+tool-call)` + `tool(result)` 消息对 | 复用 SDK 正典转换器、对 UIMessage part 形态鲁棒；自定义代码最少；**真实协议块**正是治「假装调用」的解药 |
| B 手工映射 part→content block | 自行遍历 parts 拼 content/tool 消息                                                                                                                                    | 控制最细，但重造 SDK 逻辑（tool part 状态机、dynamic-tool 命名），易与 SDK 漂移                         |
| C 文本面包屑                  | assistant 散文里塞 `[called readPage(3)→…]`                                                                                                                            | **否决**：等于教模型**用散文叙述工具调用**，可能反而强化「嘴上说调了」的坏习惯                          |

**采纳 A**。C 与本 bug 的成因直接冲突；A 较 B 更省心、更不易与 SDK 漂移。

## 3. 核心改动（`assemblePrompt`，`src/main/ai/prompt.ts`）

落点：history 循环（`prompt.ts:117-125`）。新增 assistant 轮的结构化转换，user 轮与现状完全一致。

**新增** `assistantHistoryToModelMessages(h: PromptHistoryMessage): ModelMessage[]`：

1. **过滤 parts**：剔除 `reasoning` part（决策①）。
2. **image tool-result 占位**：把 `readPage` image 输出（形如 `{ kind:"image", page, data }`，`tools.ts:140`）的 `data`（base64）替换成短文本占位（如 `[page N image omitted from history]`，**保留 page 号**）；文本类结果原样保留。附**通用兜底**：任何 file/超大 base64 内容一律占位，避免别处大图漏网。
   - 实现期需确认持久化 tool part 的 image 承载形态（原始 `{kind,data}` vs FilePart）——占位在「转换前改 part」或「转换后改 tool 消息 content」择一落实，不影响本设计成立。
3. **转换**：`convertToModelMessages([{ role:"assistant", parts: filtered }], { ignoreIncompleteToolCalls: true })`，把产出的 `assistant`（含 tool-call 块）与（若有）`tool`（含 result 块）**依序 push** 进 `out`。
   - **故意不传 `tools`**：`tools` 选项需 `createReadingTools`（要 db/bookId），传它会污染 `assemblePrompt` 的纯函数性。AI SDK v6 的 `tool-${name}` part 自带类型名与 input/output，转换无需 tools 集即可还原 tool-call/result 块。
   - ⚠ **实现期验证点**：无 `tools` 时静态 `tool-${name}` part 是否仍正确产出 `tool-call`/`tool-result` 块。若不然，回退手工映射（方案 B）或传一组**无 `execute` 的占位 tool 定义**（仅供类型对齐、不引 DB 依赖）。

**降级**：单条消息转换抛错 → 该条**回退 `textOfParts` 纯文本 assistant 消息** + `log.warn("history convert fallback", err)`（日志域 `send`/`ai`）。历史回放**绝不**搞崩发送（符合「优雅吞错必留 warn」规范）。

**保留不删**：

- `textOfParts`：降级路径、compaction（`renderFoldedTranscript`）、自动命名（`stream-assistant.ts:122`）仍用。
- `renderHistoryMessage`：compaction 仍用其文本口径（§6）。
- `renderUserTurn` 及 user 轮分支：完全不变。

## 4. 数据流与边界

- **持久化不变**：`appendMessage` 仍存全量 `responseMessage.parts`（含 reasoning/tool）；UI 历史气泡照旧。
- **resend 自动覆盖**：`runResend` 共用同一个 `assemblePrompt`，无需单独改（`send.ts:185-194`）。
- **孤儿 tool-call**：aborted/error 轮可能留「有 tool-call 无 result」的半截 → `ignoreIncompleteToolCalls: true` 自动丢弃，免 provider 报「orphaned tool_use」。
- **纯文本老消息**（无 tool part）：转换后即单条 assistant 文本，**行为等价现状**（回归保护）。
- **provider 一致性**：回放的 tool 名与每轮 `createReadingTools` 注册集一致（`getToc`/`readChapterText`/`getChapterSummary`/`readPage`）；历史轮的 `tool_use` 块**无需**伴随 thinking 块（Anthropic 允许历史轮省略 thinking，故砍 reasoning 安全，见 §5）。

## 5. reasoning 决策（跨轮砍、单轮内留）—— 显式设计决策

issue 标题含「tool/**reasoning** parts」，本 spec 的结论是**评估后跨轮砍、单轮内保留**：

- **跨轮回放（本改动）→ 砍**：持久化的 reasoning 结构**跨 provider/model 回放有 API 不匹配风险**（如 Anthropic 的 thinking block 需签名匹配，且历史轮**允许**省略 thinking）；它**不是**「假装调用」bug 的成因；且 token 成本高。故作为**显式设计决策**砍掉。
- **单轮内（streamText agent 循环）→ 留**：当前这次 `streamText` 的多步 `think → tool-call → tool-result → think → …`（全在一次调用里产出一条 assistant 消息）需要 reasoning 维持 interleaved thinking 连贯性 + 签名匹配。**这部分由 SDK 在 streamText 内部自管，本改动只动「从 DB 读历史重建 prompt」一段、根本不触及它**——两者天然不冲突。

> 边界标红：实现 `assistantHistoryToModelMessages` 的 reasoning 过滤时，作用对象**只能是 `assemblePrompt` 输入的持久化历史**，绝不可下沉到 streamText 的步内消息处理。

## 6. compaction 不动（决策②）

`renderFoldedTranscript`（喂摘要模型的字符串，`context-compaction.ts:73-81`）当前经 `renderHistoryMessage` 取纯文本。**保持现状、留作后续小项**：

- 压缩只影响**滚动摘要**；而「假装调用」的少样本污染发生在**未折叠的尾轮**——恰是结构化回放生效处。摘要器读纯文本转写**不影响**聊天模型看到的范式。
- 给转写补一行文本工具痕迹（「assistant 读了第 3 页 → …」）可**边际提升**摘要保真，但超出 issue 范围且无紧迫收益（YAGNI），暂不做。

## 7. 错误处理与降级

- 单条转换抛错 → 回退 `textOfParts` 文本 + `log.warn`，**永不阻塞发送**。
- `assemblePrompt` 保持同步纯函数：`convertToModelMessages` 为纯转换、无 IO，不破坏可测性。
- 空 parts / 无 tool part / 纯文本：安全退化为单条 assistant 文本。

## 8. 测试策略（headless vitest 纯函数，扩 `src/main/ai/prompt.test.ts`）

- assistant 轮含 `text` + tool-call + 文本 result → 产出**结构化 `assistant` + `tool` 两条**，断言 tool 名、input、output 落位。
- image 类 tool-result → 占位符（含 page 号）、**断言不含 base64**。
- reasoning part → **被丢弃**（跨轮砍）。
- 孤儿 tool-call（无 result）→ `ignoreIncompleteToolCalls` 丢弃、**不抛**。
- 纯文本老消息 → 行为不变（**现有 `renderHistoryMessage`/`assemblePrompt` 用例保持全绿**，回归保护）。
- user 轮渲染、chips 同构、system/priorSummary 拼接 → 现有断言不变。
- 降级：构造令 `convertToModelMessages` 抛错的畸形 parts → 回退文本 + 不抛（实现期定可行触发方式，如注入畸形 part 或 spy）。

## 9. 关联

- 需求 issue：[#42](https://github.com/EurFelux/marginalia/issues/42)。
- 上游：[#64](https://github.com/EurFelux/marginalia/issues/64) 会话上下文管理 spec（`docs/superpowers/specs/2026-06-08-conversation-context-management-design.md`，其 §0/§1/§6/§9 缓办本项）。
- 取证记忆：`ai-toolcall-failure-is-model-behavior`（本 bug 的直接动机）。
- 设计哲学：`src/main/ai/prompt.ts` 头注「历史与当前同构、无隐藏注入通道」「ModelMessage 按需派生不持久化」。
- 关键 API：`convertToModelMessages`（ai@6.0.193），选项 `{ tools?, ignoreIncompleteToolCalls?, convertDataPart? }`。
