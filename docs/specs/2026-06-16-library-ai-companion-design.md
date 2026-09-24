# 书库 AI 伴侣（library-level AI companion）设计

- **Issue**: [#90](https://github.com/EurFelux/marginalia/issues/90) — Add a library-level AI companion for collection discussion and next-read recommendations
- **日期**: 2026-06-16
- **状态**: 设计已认可，待写实现计划

## 1. 背景与目标

AI（Lia）目前只活在**阅读器**里：选区问答、章节/全书摘要、逐书会话。书库视图没有任何 AI 入口。

用户的根本诉求：**让 AI 拥有访问书库的能力**——在书库里也能找 Lia 聊，让她基于「书目 + 阅读历史 + 全局记忆」讨论藏书、推荐下一本读什么。「推荐下一本」只是其中一个具体场景。

范围裁定（已与用户确认）：

- **只在已拥有的书里推荐**；联网/发现新书是另一条独立线（[#89](https://github.com/EurFelux/marginalia/issues/89)），本设计不掺和。若 #89 落地，web search 只是 Lia 多出来的一个工具，与本设计正交。
- UI 形态 = **全局悬浮助手**：一个 Lia 走天下、上下文随视图切换。
- 复用同一个 `AIPanel` 组件，不另起炉灶。
- Lia 访问书库 = **纯工具、按需拉**，与现有阅读工具（getToc/readChapterText）架构同源。

## 2. 核心抽象：`ChatContext` 脊柱

一个判别联合，是 Lia 在「读书伴侣」与「图书管理员」之间翻面的**唯一开关**：

```ts
type ChatContext = { kind: "book"; bookId: string } | { kind: "library" };
```

- **渲染层**：由容器注入（见 §5），不由 `AIPanel` 自己读全局导航。
- **主进程**：沿用既有 `bookId`，仅放宽为 `string | null`（`null` = 书库上下文）。上下文在主进程侧 = bookId 的空与非空，**不新增字段**。

随上下文翻面的只有下表这些，**其余全部共享不变**（messages / 自动命名 / 上下文摘要压缩 / 模型解析 / 流式 / prompt caching / 记忆索引注入）：

| 维度                       | book 上下文（阅读器）                        | library 上下文（书库）           |
| -------------------------- | -------------------------------------------- | -------------------------------- |
| 会话归属                   | `conversations.bookId = <id>`                | `conversations.bookId = NULL`    |
| 工具集                     | 阅读工具 getToc / readChapterText / readPage | 书库工具 listBooks / getBook / … |
| base prompt                | 「reading companion」                        | 「librarian」                    |
| reading context / PDF note | 有                                           | 无                               |
| 记忆工具                   | 共享 readMemory / saveMemory / updateSoul    | 共享（同一套）                   |
| UI 容器                    | 阅读器停靠分栏                               | 书库悬浮浮层                     |

## 3. 数据模型

### 3.1 迁移

`conversations.bookId` 去掉 `NOT NULL`，**保留 FK + `ON DELETE CASCADE`**。改 `schema.ts` 后 `pnpm db:generate` 生成迁移。

- 存量行不受影响（都有 bookId）。
- `bookId IS NULL` ⇒ 书库会话。
- FK 语义不变：删书仍 CASCADE 删该书会话；null 行不挂任何书，删书不影响它。

### 3.2 选型理由（为何可空 bookId，而非伪书 / 平行表）

| 方案                             | 评价                                                                                                                                   |
| -------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- |
| **① 可空 bookId（采用）**        | 不新增表，完整复用 messages / 摘要 / 压缩 / 自动命名 / 会话列表机器；单一代码路径。代价：审计「假设 bookId 非空」处 + 一条核心表迁移。 |
| ② 哨兵伪书（`id="__library__"`） | 否决：假书污染 listBooks / 网格 / 统计 / FK 语义，到处特判隐藏。                                                                       |
| ③ 平行 `libraryConversations` 表 | 否决：要么复制整套 messages/摘要/压缩机器，要么 messages 挂两个父表，巨量重复。                                                        |

会话与书解耦、可空是正确语义。

## 4. 主进程

### 4.1 契约（`@shared/chat`）

- `ConversationDto.bookId: string | null`
- `createConversationInput.bookId` → `.nullish()`（缺省/null = 书库）
- `sendInputSchema.bookId` / `sendRequest` → `.nullable()`（null = 书库）；`conversationId` 仍必传（沿用「只校验不分配」）

### 4.2 会话仓库（`chat/conversations.ts`）

- `createConversation`：bookId 为 null 时「防堆积」查询匹配 `bookId IS NULL`，插入 `bookId: null`。
- 把 `listConversationsByBook` 泛化为接受 `string | null`（null 走 `IS NULL`），书库会话列表复用同一函数；不另起 `listLibraryConversations`。

### 4.3 发送管线（`send.ts` / `stream-assistant.ts`）

- `runSend` / `runResend`：`convo.bookId === input.bookId` 在双 null 时天然成立；`getBook` 与 PDF note 仅在 bookId 非空时执行。
- `streamAssistantReply`：工具按上下文分流——

  ```ts
  const tools = {
    ...(bookId
      ? createReadingTools({ db, bookId, loadBytes, imageToolResults })
      : createLibraryTools({ db })),
    ...memoryTools, // createMemoryTools 已是 null-tolerant（sourceBookId 可为 null）
  };
  ```

  `StreamCtx.bookId` → `string | null`。

- `buildSystemPrompt(db, conversationId, bookId)`：按 null 与否选 base prompt（现有 reading-companion vs 新增 **librarian** 版）；记忆指引 + agent context（SOUL + 记忆索引）两者都拼。新增 `LIBRARY_SYSTEM_PROMPT`：点明「你能通过工具访问读者的整个书库，帮他讨论藏书、决定下一本读什么；推荐须落在阅读历史与记忆上；用读者的语言作答」。

### 4.4 书库工具（新建 `ai/library-tools.ts`）

只读、纯函数注入 DB、沿用阅读工具的错误纪律（`runTool` 失败转 `{ error }` 不抛、模型自纠）：

- `listBooks()` → 书目 `{ id, title, author, format, isFinished, progressPercent, lastReadAt }`（复用 `listBooks` / `listRecentlyRead` 的 join）。
- `getBook(bookId)` → `{ title, author, format, pageCount, isFinished, summary, summaryStatus, addedAt }`（复用 `getBook` + `getBookSummaryView`）。bookId 不命中 → `{ error }` 附「先调 listBooks」提示。
- `getBookNotes(bookId)` → Markdown 笔记（`listBookNotesByBook`）。
- `listAnnotations(bookId)` → 高亮 `{ selectedText, note, style }`（`listAnnotationsByBook`）。
- `getReadingStats()` → 总时长 / streak / 各书时长（复用 Stats 视图 IPC 的统计装配：`aggregateStats` 给非 perBook 部分，perBook 另查 `reading_daily` 按书聚合）。

记忆能力已由共享记忆工具（readMemory/saveMemory/updateSoul）+ 系统 prompt 的记忆索引覆盖，无需新增。

## 5. 渲染层

### 5.1 context 由容器注入

`AIPanel` 加 `context: ChatContext` prop，**两个容器各自传入**（即「复用同一个 AIPanel」的落地）：

- 阅读器停靠容器：`<AIPanel context={{ kind: "book", bookId }} />`（现状）
- 书库悬浮容器：`<AIPanel context={{ kind: "library" }} />`

`AIPanel` 内所有「书相关」读取改走 context：`convosQuery`、active 会话槽、`newConversation`、header 标题、transport 工厂。

### 5.2 chat-store：保留 `activeByBook`，库上下文单独加标量

**不重命名 `activeByBook`**（改名才会让旧持久化键不水合而丢记忆）。改为：

```ts
activeByBook: Record<string, string | null>; // 保持现状，旧持久化数据逐字水合
activeLibraryConversation: string | null; // 新增，仅此一个（书库上下文是单例）
```

helpers 按 `ctx.kind` 分流：

```ts
getActiveConversationId(ctx) =
  ctx.kind === "book" ? (activeByBook[ctx.bookId] ?? null) : (activeLibraryConversation ?? null);

setActiveConversation(ctx, id) =
  ctx.kind === "book" ? 写 activeByBook[ctx.bookId] : 写 activeLibraryConversation;
```

persist 的 `partialize` 同时持久化两者：`{ activeByBook, activeLibraryConversation }`。

**结果**：`marginalia-chat` 里 `activeByBook` 键名不变 → 「每本书上次开哪个会话」的视图记忆**逐字保留、零迁移、零丢失**；新字段从 `null` 起步。`setActiveConversation` 不再依赖 `rememberSlot` 读 `currentBookId`，由 ctx 显式带入。

> 不用 zustand persist 的 `version + migrate` 改写旧 map 进新 keyspace：那条路也能不丢，但多了 bump 版本 + 迁移函数 + 测试的活动部件；书库上下文本就是单例，用标量建模更诚实、旧数据天然原样可用。

### 5.3 跨视图会话连续性 = 自然涌现

每个 context 有独立 active 槽 → 进书 A 看 A 的会话、回书库看书库会话。「上下文随视图切换」**不需要额外切换逻辑**，由 context-keyed 槽自动得到。

### 5.4 悬浮容器（新建 `FloatingAssistant`，挂在 `AppShell`）

- 常驻启动按钮（右下 FAB），仅在 library/stats 视图出现（`AppShell` 只渲染这两个视图，阅读器走 dock，天然不重叠）。
- 打开 = 右下固定定位浮层，内嵌 `<AIPanel context={{ kind: "library" }} />`，用既有 Base UI 基元。
- 拖拽/缩放先不做（固定尺寸 + 内部滚动），列入后续打磨。

### 5.5 书库会话列表

把现有 `ConversationsTab` **泛化为收 context**，在浮层里作可折叠列表复用——书库直接获得与阅读器一致的多会话管理（新建/切换/删除/自动命名），零新增列表组件。

### 5.6 transport（`ipc-chat-transport.ts`）

`createIpcChatTransport(context)`：

- book 上下文：现状（bookId = `context.bookId`）。
- library 上下文：`bookId = null`、移除 `!currentBookId` 守卫、`conversations.create({ bookId: null })` 懒建、`readingContext = null`。
- `getActiveConversationId(context)` 收 context。

## 6. 错误处理

沿用现有纪律：

- 工具失败转 `{ error }`，模型自纠。
- 模型未配置 → 同一「请在设置配置 API Key」banner。
- 空书库 → `listBooks` 返回 `[]`，Lia 自然应对（librarian prompt 可点一句「库里还没有书」）。
- book 上下文的 `noBookToSend` 守卫保留，仅 library 路径豁免。

## 7. 测试

- **主进程**：书库工具单测（`:memory:` 播种 books/progress/annotations/notes/reading_daily → 断言输出）；`runSend(bookId=null)`（书库工具已接、无 PDF note、记忆工具在、librarian base prompt）；`createConversation` / list 的 null 路径；library 会话 resend。
- **契约**：`ipc` schema 的 nullable bookId 测试。
- **渲染层（headless）**：context 派生、chat-store 按 context 的槽（含旧 `activeByBook` 水合不丢）、transport library 路径（沿用既有 transport 测试套路）。
- **迁移**：`db:generate` 后 client 测试——library 会话行可建、删书不误伤、CASCADE 正常。
- **冒烟**（CDP，需已配模型，可能手动）：书库开浮层问「下一本读什么」→ 断言 Lia 调了书库工具并回复。

## 8. 不做（范围边界）

- ❌ 跨全库逐章读正文工具（太重；深读仍属 book 上下文）。
- ❌ 联网/发现新书（独立 #89）。
- ❌ 新 agent / 人格——同一个 Lia，共享 SOUL + 记忆。
- ❌ 阅读器内不加悬浮（保留 dock，避免双入口）。
- ⏳ 浮层拖拽/缩放后续打磨。
