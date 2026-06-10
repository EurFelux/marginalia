# AI 全局记忆 + SOUL 设计（issue #77）

日期：2026-06-10
状态：草案（待用户审阅）
关联：#77（Add global persistent memory for the AI reading companion）

## §0 背景与目标

Marginalia 的 AI 目前每个会话从零开始：不知道读者读过什么书、有过什么思考、关注什么概念、用什么框架理解问题。本设计为应用内 AI 引入**全局持久记忆**与 **SOUL（agent 自我设定）**，让它成为一个「认识读者、也认识自己」的阅读伴侣。

**核心范式**（区别于后台提取管线）：参考 Claude Code 的记忆机制——给 agent 记忆读写**工具**，由它在对话中**自主决定**何时记、记什么；不设计独立的后台提取流程（难以控制、与对话脱节）。

**分阶段愿景**：

- **本期（阶段一）**：对话更懂你——记忆静默注入，AI 回答自带读者背景。重心是地基的可扩展性。
- **阶段二（不在本期）**：跨书主动联想——「这段和你读《X》时关注的 Y 呼应」。本期通过 `sourceBookId` 与索引架构铺路。

**信号源（本期）**：AI 对话内容 + 用户显式告知（两者统一为 AI 自主调工具）。标注/笔记、阅读行为模式留给未来。

## §1 核心决策总览

| 决策点       | 结论                                                                                 |
| ------------ | ------------------------------------------------------------------------------------ |
| 范式         | 无后台提取管线；agent 通过工具自主读写记忆                                           |
| 作用域       | 全局一份（跨书、跨会话共享）                                                         |
| 条目形态     | 索引常驻 system prompt（title + description）+ 正文按需 `readMemory`                 |
| 可见性       | 可管理（设置页查/编/删 + 总开关）+ 注入静默；写入经 inline tool steps 天然可见       |
| 存储         | SQLite `memories` 表（不用文件式——「参考 Claude Code」的精髓是交互范式而非存储介质） |
| 架构简化     | 彻底删除 `assistants` 表，全局单一 agent                                             |
| SOUL         | agent 自我设定：`name` 独立字段 + 自由 markdown `persona`；用户与 AI 都可写          |
| instructions | 用户给 agent 的行为指令（接替原 `systemPrompt`），独立于 SOUL；**仅用户可写**        |
| 默认名字     | **Lia**（margina-**lia** 词尾）                                                      |
| 缓存稳定性   | instructions + SOUL + 记忆索引按会话快照冻结；SOUL/instructions 写入时主动失效快照   |

## §2 数据模型

### 2.1 新表 `memories`

遵循项目惯例（uuidv7 主键、毫秒时间戳）：

```
memories
├─ id            text PK (uuidv7)
├─ title         text NOT NULL        -- 短标题，如「用经济学框架理解社会问题」
├─ description   text NOT NULL        -- 一行摘要；常驻注入 system prompt 的就是它
├─ body          text NOT NULL        -- 详细正文；readMemory 按需取
├─ sourceBookId  text NULL → books.id (ON DELETE SET NULL)  -- 「在哪记下的」溯源
├─ createdAt     integer NOT NULL
└─ updatedAt     integer NOT NULL
```

取舍：

- **不做 type 分类**（preference/insight/concept…）：title + description 已足够表达，分类徒增 AI 写入负担。阶段二需要筛选时再加列。
- **`sourceBookId` 由主进程自动填**（从会话 bookId 取），不作为工具入参。它只是溯源标签，不表示记忆归属于某本书——记忆是全局事实。
- **硬删除**，无软删。

### 2.2 preferences 新增

| key             | 形态                                | 默认                            | 说明                                                                         |
| --------------- | ----------------------------------- | ------------------------------- | ---------------------------------------------------------------------------- |
| `chatModel`     | `{ providerId, model }`             | 迁移自 assistants               | 聊天模型配置（仿 `summaryModel` 模式）                                       |
| `memoryEnabled` | `boolean`                           | **true**                        | 记忆总开关。空库注入零成本，与烧钱的 `autoSummarize`（默认关）默认值哲学不同 |
| `soul`          | `{ name: string, persona: string }` | name=`"Lia"` + 内置默认 persona | agent 自我设定                                                               |
| `instructions`  | `string`                            | `""`（空）                      | 用户给 agent 的行为指令（接替原 `systemPrompt` 的用户自定义空间，见 §3）     |

SOUL 与 instructions 存 preferences 而非单独表：单行单实体，用户编辑走现成 `preferences:get/set` IPC + per-key Zod schema，AI 写（仅 SOUL）是主进程内 `setPreference`，零新基建。

⚠️ 已知坑：preferences 注册新 key 必须补 `preferences:set` handler 的 switch case（never 守卫兜底，验证落盘以 sqlite 为准）。

### 2.3 删除 `assistants`

- 删 `assistants` 表与 `conversations.assistantId` 列（表重建迁移；FK 事务坑已有 `runMigrations` 事务外切 FK 的处理）。
- **迁移无损搬运**：现有默认助手的 `providerId`/`model` 用 `json_object()` 写入 `preferences.chatModel`；`systemPrompt` 搬入 `preferences.instructions`——但**仅当用户改过**（与 `DEFAULT_SYSTEM_PROMPT` 原文不同）时才搬，未改过则 instructions 留空（旧默认文案的精神已被①层内置模板吸收，照搬会与之重复）。
- `resolveAssistantModel()` → `resolveChatModel()`：从 preferences 读，未配置时报错引导设置（与 `summaryModel` 同语义：显式优于隐式，不静默回退）。
- 摘要系列（章摘/书摘/自动命名/压缩）继续走 `summaryModel`，与 `chatModel` 互不影响。

## §3 system prompt 分层

每轮对话的 system prompt 按五层组装：

```
① 内置基础模板（代码维护，随版本进化，用户不可编辑）
   —— 行为框架、工具指引、记忆指引、「跟随用户语言回复」
② instructions（preferences.instructions，仅用户可写）
   —— 用户给 agent 的行为指令；默认空
③ SOUL（preferences.soul，用户与 AI 都可写）
   —— "你叫 {name}。{persona}"
④ 记忆索引（memories 表派生，会话快照冻结，见 §5）
   —— 每条一行：[id] title — description；空库时整段不注入
⑤ 既有动态层：PDF 页粒度注记、会话滚动概要（compaction）
```

**instructions 与 SOUL 的分界**（控制权对偶）：

- **instructions = 用户给 agent 的规矩**（第二人称：「你要…」），仅用户可写——`updateSoul` 工具碰不到它，agent 不能改写主人的要求。类比 Claude Code 的 CLAUDE.md。
- **SOUL = agent 的自我**（第一人称：我是谁、我怎么说话），用户与 AI 共写——这是可演化的人格空间。
- 原 `DEFAULT_SYSTEM_PROMPT` 的行为要点（基于选区作答、用阅读工具、简洁）吸收进①层；`instructions` 默认空，是纯粹的用户自定义空间。

### 3.1 内置模板中的记忆指引（①层要点，措辞实现时打磨）

- **该记**：用户表达持久偏好、独到观点、反复关注的概念、理解问题的框架、对 agent 行为的纠正。
- **不该记**：书的内容本身（摘要机制已覆盖）、一次性的事务性问题。
- **防重复**：索引常驻可见——相近主题用 `updateMemory` 合并，不堆相似条目。
- **与会话概要的分工**：compaction 概要是本会话的工作记忆；值得跨会话长期记住的才进 `saveMemory`。
- **记忆语言**：用用户使用的语言书写记忆内容。

### 3.2 默认 persona（出厂值，实现时打磨）

简短英文文案（语言跟随由①层保证），定位：温暖、好奇、克制的阅读伴侣；不堆砌人设细节，留足用户与 Lia 共同演化的空间。「首次见面起名仪式」留给 onboarding 轨（阶段二）。

## §4 工具集

加在现有 `tools.ts`（`getToc`/`readChapterText`/`readPage`…）旁：

| 工具           | 入参                                  | 说明                                                                               |
| -------------- | ------------------------------------- | ---------------------------------------------------------------------------------- |
| `readMemory`   | `{ id }`                              | 取记忆正文（索引只有 title+description）                                           |
| `saveMemory`   | `{ title, description, body }`        | `sourceBookId` 主进程自动填；返回新 id                                             |
| `updateMemory` | `{ id, title?, description?, body? }` | 修正、合并、丰富                                                                   |
| `deleteMemory` | `{ id }`                              | 用户要求遗忘或记忆过时                                                             |
| `updateSoul`   | `{ name?, persona? }`                 | 自我演化：「以后你叫…」「说话简洁点」；只触及 SOUL，碰不到 instructions（§3 分界） |

**开关语义**：`memoryEnabled = off` → 4 个记忆工具不注册 + ③层索引不注入（模型不知道记忆系统存在）。**SOUL 与 `updateSoul` 不受此开关控制**——SOUL 不是关于用户的数据，它是 agent 本身。

**写入可见性**：注入静默，但写工具调用出现在对话流的 inline tool steps（现有 UI 机制）——用户能看到「Lia 刚记住了什么 / 改了自己什么」，类似 ChatGPT 的「已更新记忆」提示，零新 UI。

**已知风险（接受）**：工具调用积极性依赖模型质量——弱模型可能从不存记忆（参考 DeepSeek 推理模型不发 tool_call 的既往取证）。记忆读取路径对弱模型同样退化（不调 `readMemory` 则只享受索引行信息）。

## §5 缓存稳定性：会话快照冻结

**问题**：所有主流 provider 的 prompt cache 都是前缀匹配（Anthropic：tools → system → messages）。记忆索引、SOUL 或 instructions 变化会使 system 变化，**进而失效整个对话历史的缓存**，下一轮全价 input 重算。

**方案**：每个会话**首轮发送时**渲染「instructions + SOUL + 记忆索引」并快照（进程内 `Map<conversationId, snapshot>`）；本会话后续每轮复用快照——system prompt 在会话生命周期内逐字稳定。

**为什么冻结几乎无体验损失**：

- 本会话内，新记忆**活在对话历史里**（刚发生的工具调用就在上下文中，模型本来就「记得」）。
- 跨会话时，新记忆才需要活在索引里——新会话生成新快照，自然带上。

两条通道互补，无盲区。

**快照失效细则**（按变更来源区分）：

- **记忆写入**（`saveMemory`/`updateMemory`/`deleteMemory` 或设置页编辑）→ **不**清快照：本会话靠对话历史补偿，新会话自然刷新。设置页编辑记忆通常发生在对话之外，下个会话生效完全符合直觉。
- **SOUL / instructions 写入**（设置页或 `updateSoul`）→ **清空全部快照**、立即生效：人设与规矩的变更用户期待下一句就兑现；设置页改动不在任何对话历史里，无补偿通道，必须立即生效。牺牲一次缓存，低频可接受。

**实现细节**：

- 快照**不持久化**：app 重启丢失即重新生成（provider 缓存 TTL 5 分钟～1 小时，早已过期，语义零损失）。
- 索引渲染**确定性排序**（`createdAt, id`），杜绝无谓抖动。
- 会话删除时清理对应快照（防泄漏）。
- ⑤层的 compaction 概要变化仍会失效缓存——那是拿一次失效换后续每轮省约 90k token，稳赚，维持现状。

## §6 IPC 与管理 UI

**新 IPC 通道**（Zod schema 进 `src/shared/ipc.ts`，走 `registry.handle()` 校验）：

- `memories:list` / `memories:update` / `memories:delete` —— 管理面板用。
- 不做 `memories:create`：用户手动造记忆不是真实场景，记忆应在对话里自然长出（YAGNI）。
- SOUL 与开关走现成 `preferences:get/set`，零新通道。

**设置页两个新版块**：

- **记忆**：总开关 + 列表（title · description · 来源书名 · 时间），点开看正文、可编辑、可删除。
- **助手**：name 输入框 + persona 文本域（SOUL）、instructions 文本域、`chatModel` 选择器（由原 assistant 配置 UI 改造，仿 `summaryModel` 选择器）。

**UI 中的名字**：聊天面板标题、助手消息署名等处显示 `soul.name`（具体落点实现时随 UI 现状定）。

## §7 错误处理与边界

- **写工具失败**：工具结果返回真实错误文本给模型、由它告知用户（透传真实 message，不编造）；同时 `log.warn` 落盘。
- **模型自纠**：`readMemory`/`updateMemory`/`deleteMemory` 收到不存在的 id → 返回「该记忆不存在」的工具结果（不抛 IPC 错误），模型对照索引自纠。
- **记忆库空**：③层整段不注入。
- **编辑重发**：历史 tool parts 只回放不重执行（现有机制），无重复写入风险。
- **删书**：`sourceBookId` SET NULL，记忆保留——全局事实不随书消失。
- **Token 预算**：暂不设条目数硬上限；模板引导 Lia 主动合并精炼，观察真实增速后再治理（YAGNI）。
- **隐私**：数据全部本地 SQLite；记忆索引与正文仅在对话请求中发往用户自行配置的 provider。

## §8 测试策略

全部无头 vitest + `:memory:` DB，纯函数注入风格：

- memories repository CRUD + 删书 SET NULL。
- 索引渲染：确定性排序、空库不注入。
- 五层 system prompt 组装（模板 + instructions + SOUL + 索引 + 动态层；instructions 空时不注入空段）。
- 工具 handler：自动填 `sourceBookId`、不存在 id 的自纠返回、`memoryEnabled=off` 不注册、`updateSoul` 不能触碰 instructions。
- 快照冻结：同会话两轮逐字一致、新会话见新记忆、记忆写入不清快照、SOUL/instructions 写入清快照、会话删除清理快照。
- 迁移：assistants → `preferences.chatModel` 无损搬运；`systemPrompt` 改过才搬入 `instructions`、未改过留空。

## §9 分期

- **本期**：`memories` 表 + 5 个工具 + SOUL + instructions + 删 assistants + 设置页两版块 + 会话快照冻结。
- **阶段二**（铺路已留）：跨书主动联想、`searchMemories`（SQLite FTS5）、记忆数量治理、首次见面起名仪式（onboarding 轨）。

## §10 开放问题（候选缺口，待用户定夺）

以下能力本设计**未**覆盖，列出供判断是否为「还差的那块」：

1. **Lia 的主动性**：当前设计中 AI 完全被动（用户先发言才有一切）。「沉浸的伴侣感」很大程度来自主动性——例如打开书时 Lia 主动开场（「上次读到第三章，我们聊过 X」）。这需要触发时机、频控、打扰边界的独立设计。
2. **记忆互链**：Claude Code 记忆机制中的 `[[name]]` 互链未对应——记忆之间的概念网络对阶段二「跨书联想」可能很重要（顺着链找到相关思考）。
3. **记忆的时间衰减/置信度**：读者的观点会变化，旧记忆可能过时。当前仅靠 Lia 主动 `updateMemory`/`deleteMemory` 维护，没有系统性的「陈旧标记」。
4. **对话外的记忆入口**：记忆只在对话中生效与生长。标注/笔记（本期已排除的信号源）之外，是否需要「读完一本书时的回顾仪式」之类的记忆沉淀时机。
