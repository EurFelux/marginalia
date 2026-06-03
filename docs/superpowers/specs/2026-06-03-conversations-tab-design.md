# 会话 tab（侧栏第三 tab · 列表 + 重开）· 设计文档

> 状态：已确认范围与方案（用户 2026-06-03 拍板「列表 + 重开 MVP」、跨章砍掉、title 创建时落库随便起 + 未来自动命名、重开只载历史不跳章、tab 选中才显文字 label）。分支 `feat/conversations-tab`。

## 1. 背景与动机

UI 原型（`packages/ui-prototype/.../Sidebar.tsx`）的侧栏有三个 tab：`目录` / `标注` / **`会话`**；渲染层只落地了前两个，**会话 tab 缺失**。当前会话完全隐式——`activeConversationId` 只由发消息的 ack 设、或开书时清空，**没有任何「重开历史会话」的 UI 路径**，`AIPanel` 每次以空 `messages` 起、从不载历史。本轮补上会话 tab：列出本书会话、点击重开并把历史消息载入面板。

后端基本就绪：`chat.conversations.listByBook` 与 `chat.messages.listByConversation` **均已在 preload 暴露**（query key `qk.conversations`/`qk.messages` 已定义但无消费方）；`routeConversation` 是**每章 find-or-create**（一章至多一个会话，独立会话只走已砍的显式入口）。

## 2. 范围

**MVP = 列表 + 重开**：

- 侧栏加第三 tab「会话」，列出本书所有会话（`updatedAt` 倒序）。
- 点击某会话**重开**：设 `activeConversationId` + 载入历史消息到 AI 面板。**不跳章**。
- 发消息仍走现有 `ai:send` 路径（`routeConversation` 不改）。

**跨章 descope**：「跨章会话」（M-c：`routeConversation(chapterIds[])` + 跨章选区→独立会话 + 组合摘要）**砍掉**。无代码可删（`routeConversation` 现为 scalar `chapterId`，全代码无 `chapterIds[]`），仅 doc 标记（见 §7）。

**非目标（本轮不做）**：新建独立会话 / 同章多会话 / 自动命名（LLM 起名）/ 删会话 / 改标题 / 跨章。

## 3. 现状关键事实（来自代码勘探）

- **`ConversationDto`**（`src/shared/chat.ts`）：判别联合 `kind: "chapter" | "independent"`，字段含 `id/bookId/assistantId/title: string | null/createdAt/updatedAt` + `chapterId`。`listConversationsByBook` 已返回它（含 `title`、`updatedAt`、`chapterId`）。
- **`title` 恒为 `null`**：`createConversation`（`src/main/chat/conversations.ts:25`）从不写 `title`；DB 列 `conversations.title` 存在且可空（`schema.ts`）。
- **`MessageDto`**（`src/shared/chat.ts:62`）：`{id, conversationId, role, parts: UIMessage["parts"], metadata, status, seq, createdAt}`。`listMessages` 按 `seq ASC` 返回。
- **preload 暴露**：`window.api.chat.conversations.listByBook(input)` 与 `window.api.chat.messages.listByConversation(input)` 均可用（`conversations:create`/`get` 为 main-only，本轮用不到）。
- **现 Sidebar**（`src/renderer/reader/Sidebar.tsx`）：Base UI Tabs，仅 `toc`(`ChapterList`) / `notes`(`AnnotationsList`) 两 tab，两个 trigger 均**恒显「图标 + 文字」**。
- **chat-store**（`src/renderer/store/chat-store.ts`）：`activeConversationId` + `setActiveConversation` 已有；开书清空在 `navigation-store`。
- **AIPanel**：`useChat({ transport })` 空 messages 起；`setMessages` 已暴露（「新对话」按钮 `setMessages([])` 在用）；**从不调 `messages.listByConversation`**。
- **章节标题来源**：`ChapterList` 已 `useQuery` 章节列表（`content.chapters`）；会话 tab 复用同一 query key 解析 `chapterId → 章节标题`。

## 4. 设计

### 4.1 会话标题：创建时落库「随便起」+ 兜底 + 未来自动命名

不在显示时派生 preview（避免改 list 返回形状 / 加字段 / N 查询），改为**会话创建时往 `title` 列写一个糙标题**，列表直接读 `ConversationDto.title`：

- **落库时机/内容**：会话由 `runSend` 内 `routeConversation` 首次创建（`RouteDecision.created === true`）时，把 `title` 设为**首条用户消息截断**（取 `userText` 首行、截断到约 40 字符，纯函数 `deriveConversationTitle(userText)`）。`routeConversation` 保持纯路由不动（其测试不动）；在 `runSend` 拿到 `created` + `userText` 处调用新增 repository fn `setConversationTitle(db, id, title)`。
- **兜底**：历史遗留 `title === null` 的会话，列表显示回退 `章节标题 ?? t("conversations.untitled", "未命名会话")`（i18n）。
- **未来**：自动命名会话（LLM 依据对话内容起名）列入 backlog；届时覆盖同一 `title` 字段，**消费方（tab）无需改动**——这是「先填糙的、后填好的」留的天然覆盖点。

> 用 `title` 列承载糙标题 → 自动命名是同字段升级，tab 读法不变。

### 4.2 会话 tab UI（`ConversationsTab` + TabsList 选中才显文字）

**TabsList 整体改为「图标恒显 + 仅当前选中 tab 显文字 label」**（i18n 适配：多语言 label 宽度不一，只让选中项显全文，保证 tab group 不溢出）。此改动**含现有 `toc`/`notes` 两 trigger**（正在动的代码，顺带对齐）：

- 机制：每个 `TabsTrigger` 恒渲染图标 + 一个文字 `<span>`，`<span>` 默认隐藏、仅在该 trigger **选中态**显示。选中态用 Base UI Tab 的 data 属性驱动（实现时确认实际属性名——见记忆 `shadcn-base-ui-setup` 「tabs data-orientation 错配」坑）。
- **a11y**：未选中 tab 只剩图标，每个 trigger 须挂 `aria-label`（= 该 tab 的 i18n 文案），保证屏幕阅读器拿得到可读名；图标可按需挂 Tooltip（顶栏已有原语）。
- 三 tab：`目录`(List) / `标注`(Highlighter + 计数 badge) / `会话`(MessagesSquare)。

**`ConversationsTab` 组件**（`src/renderer/reader/` 新增，邻 `ChapterList`/`AnnotationsList`）：

- `useQuery(qk.conversations(bookId), () => window.api.chat.conversations.listByBook({ bookId }))`。
- 每行（`<button>`）：`MessagesSquare` 图标 + **主标签 = `title`（兜底如 §4.1）** + 右侧副标签「章节标题 / `t("sidebar.independent")`」+ 相对时间（`updatedAt`，i18n 相对时间格式）。
- **主标签 title 必须 UI 视觉截断**：单行省略号（`flex-1 truncate`，min-w-0 防 flex 不收缩），与原型一致。**独立于** §4.1 的后端 ~40 字截断——后端截断防 DB 存超长，UI 截断防窄侧栏/长标题（含未来自动命名产出的长标题、兜底章节标题）溢出撑破行布局。副标签（章节/时间）shrink-0 不被压。
- active 行高亮（`id === activeConversationId`，读 chat-store）。
- 空态：无会话时显 i18n 文案（如「还没有会话」）。
- React Compiler 已启用——不手写 `useCallback`/`useMemo`（见记忆）。

### 4.3 重开流程（核心 plumbing）

点会话行 → 重开为「设 active + 载历史到面板」：

1. `setActiveConversation(id)`（chat-store）。
2. `window.api.chat.messages.listByConversation({ conversationId: id })` 取 `MessageDto[]`。
3. **转 `useChat` 的 `UIMessage[]`**：`MessageDto.parts` 本就是 `UIMessage["parts"]`，近乎直传——取 `{ id, role, parts }`（`metadata` 按 `useChat` 需要附带）。提供纯函数 `messageDtoToUIMessage(dto)`。
4. `setMessages(uiMessages)`（AIPanel 的 `useChat` 暴露）。
5. **若有流在跑**：先 `abort` 当前 in-flight send，再载新历史（避免 streamId 串台 / 增量灌错会话）。
6. **不跳章**：阅读区不动。随后若在「别的章」发消息，按现有 `routeConversation` 会切到当前章的会话（沿用现有 `switchedFromActive` 提示）——这是既有行为，本轮不改。

**联动刷新**：发消息 ack 回来后（可能新建会话 / 更新 `updatedAt` / 首次写 `title`）**失效 `qk.conversations(bookId)`**，让列表即时反映。

> **重开编排——用一次性命令信号，不监听 `activeConversationId`**（关键正确性点）：
> `activeConversationId` 也会被**发消息的 ack 路径**写入（新建会话时 `null → newId`，见 `ipc-chat-transport`）。若 `AIPanel` 用 `useEffect` 监听 `activeConversationId` 变化去载历史，则**每次发消息新建会话后都会触发、用 DB 历史 `setMessages` 覆盖刚流式出来的内容**（串台 bug）。
> 故把「重开」建模为**一次性命令信号**（镜像 #10 `annotation-store` 的 `scrollCommand` 模式）：chat-store 加 `openConversation(id)` → 设 `openCommand: { conversationId, nonce }`（并顺手 `setActiveConversation(id)` 给即时高亮）。`AIPanel` 只监听 `openCommand` 的 `nonce` 变化去（abort in-flight →）载历史 + `setMessages`；**ack 路径只动 `activeConversationId`、绝不碰 `openCommand`**，故发消息不会触发历史重载。命令信号一次性、可丢、可重建（同 store 性质分层原则）。

### 4.4 主进程改动（最小）

- 新增 `setConversationTitle(db, id, title)`（`src/main/chat/conversations.ts`）：`update conversations set title where id`。
- 新增纯函数 `deriveConversationTitle(userText): string`（首行 + 截断，空串兜底）。
- `runSend`（`src/main/ai/send.ts`）：`routeConversation` 返回 `created === true` 时，调 `setConversationTitle(db, conversationId, deriveConversationTitle(userText))`。
- `listByBook` / `listByConversation` / `ConversationDto` / `MessageDto` / IPC 契约 **全不改**（`title` 列已存、`listByBook` 已返回）。

## 5. 数据流（端到端）

```
[侧栏会话 tab] ──listByBook──▶ ConversationDto[]（含 title/chapterId/updatedAt）
      │ 点击行
      ▼
chat-store.openConversation(id)  → openCommand{conversationId,nonce} (+ setActiveConversation 高亮)
      │ AIPanel 监听 openCommand.nonce（非 activeConversationId）
      ▼
（若在流→abort）──messages.listByConversation──▶ MessageDto[]
      │ messageDtoToUIMessage
      ▼
useChat.setMessages(UIMessage[])  → 面板显示历史
      │ 用户发消息 → ai:send（routeConversation；首建会话则 setConversationTitle）
      ▼
ack → setActiveConversation + invalidate qk.conversations(bookId) → 列表刷新
```

## 6. 测试策略

- **headless（vitest）**：
  - `deriveConversationTitle`：空串 / 超长（截断到约 40）/ 多行（取首行）/ 含空白边界。
  - `setConversationTitle`：写入后 `getConversation`/`listConversationsByBook` 读到新 title（`:memory:` DB）。
  - 「send 首次创建会话 → title = 截断 userText」：在 send 流程层测（既有 send 测试旁加一例：`created` 路径落 title；复用会话路径不覆写 title）。
- **renderer**：`ConversationsTab` 列表渲染 + 兜底标签（title null → 章节标题 → 未命名）+ 重开点击设 active；`messageDtoToUIMessage` 纯函数测。
- **手测**：真书发几条消息生成会话 → 切到会话 tab 看列表（标题/章节/时间）→ 重开看历史载入 → tab 选中切换只显选中文字。

## 7. 跨章 descope（doc 改动清单）

把以下「跨章」目标标为**砍掉/descoped**（仅 doc，不动代码）：

- `docs/superpowers/ROADMAP.md`：当前焦点 §下一目标候选去掉「M-c 跨章」；主进程表 `M-c` 行 → 🚫 砍掉；RA 轨 `RA4` 行去掉「跨章会话」（仅留摘要查看，标 ✅）；接缝表「跨章选区 → 独立会话」行 → 🚫 砍掉。
- 原型预留（`packages/ui-prototype` 的「新建独立会话」/「独立会话」行）**不动**（原型存档）。
- 既有 plan/spec 里的跨章描述**不改写**（历史文档），仅以 ROADMAP 为准声明砍掉。

## 8. 改动文件清单（概览，细节见 plan）

**改：**

- `src/renderer/reader/Sidebar.tsx`——加第三 tab「会话」+ TabsList 改「选中才显文字」+ 三 trigger 加 `aria-label`。
- `src/main/chat/conversations.ts`——加 `setConversationTitle` + `deriveConversationTitle`（或 title helper 放纯函数文件）。
- `src/main/ai/send.ts`——`created` 时设 title。
- `src/renderer/store/chat-store.ts`——加 `openConversation(id)` + 一次性 `openCommand: { conversationId, nonce }` 命令信号（镜像 `annotation-store` scrollCommand）；复用现有 `setActiveConversation`。
- AIPanel——监听 `openCommand.nonce`（非 `activeConversationId`）载历史 + `setMessages`（in-flight 先 abort）。
- i18n locale——新增 `sidebar`/`conversations` 文案键（`目录`/`标注`/`会话`/`未命名会话`/空态等）zh-CN/en。
- `docs/superpowers/ROADMAP.md`——跨章 descope + 会话 tab 交付登记（收尾时）。

**新增：**

- `src/renderer/reader/ConversationsTab.tsx`。
- 相关纯函数（`messageDtoToUIMessage` / `deriveConversationTitle`）+ 测试。

**不改：** `ConversationDto`/`MessageDto`/IPC 契约 `C`/`routeConversation`/`listByBook`/`listByConversation`。

## 9. 追加：跨章路由 + 「无 active」语义（2026-06-04，用户决定，取代 §4.3 第 6 点与 §8「不改 routeConversation」）

会话 tab 手测后用户裁定：**active 会话章节 ≠ 划词章节时应建新会话**（无「一章一会话」约束，复用旧会话不符直觉）；且**会话只在 send 时创建**、「不同章划词」只是渲染层**进入无 active 状态**（不写库）。落地：

- **`routeConversation` 新语义**：active 存在且同书且（独立 `chapterId===null` 或同章）→ 追加；**其余一律建新**（含无 active / 陈旧 id——**弃 find-or-create「复活」**，显式重开由会话 tab 取代；「新对话」后提问从此真·新会话）。`switchedFromActive` 仅在离开「同书、不同章的活会话」时为 true。
- **渲染层「不同章划词 → 进入无 active」**：chat-store 增 `activeConversationChapterId`（显示中会话所属章：`openConversation(id, chapterId)` 从 tab 传入 / send ack 回写当前章 / 置 null 时同清）；`startAiAction`（划词→AI 问）在章节不匹配时 `setActiveConversation(null)`；AIPanel 增「`activeConversationId === null` → 清面板」effect（统一覆盖划词清 / 新对话 / 开书）。
- **关键时序约束**：`handleSend` 对「跨章自由输入」的防御兜底**只清面板、不得 null 化 active**——否则「active===null → 清面板」effect 会在 React 提交后把 `sendMessage` 刚加入的用户消息一并擦掉（ack 异步设新 id 晚于 effect）；该路径路由交给主进程防御分支（active 不同章 → 建新），ack 回写即纠正 active 与所属章（active 全程不经 null）。
