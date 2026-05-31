# Marginalia · 核心阅读闭环（Phase 1）设计文档

> 状态：设计已确认，待落实施计划
> 日期：2026-05-31
> 上游：本文件是对仓库根 `SPEC.md` 的范围收敛与细化，仅覆盖 **Phase 1**。

---

## 1. 概述与范围

Marginalia 是一个 Electron + React 的桌面 ePub 阅读器，核心差异化在于**选区驱动的 AI 工作流**：用户在连续滚动的阅读区划选文本，从浮动工具栏触发 AI，在侧栏与一个**有上下文意识**的助手对话。

本 Phase 把范围收敛到**核心阅读闭环**，最快验证核心体验。

### 范围内（Phase 1）

- ePub 导入与连续滚动阅读（epub.js `flow: "scrolled"`）
- 阅读进度保存 / 恢复（CFI）
- 选区 → 浮动工具栏 → AI 对话闭环
- **分层上下文**：选区/段落（逐字、每条消息）+ 章节摘要（懒生成、会话级共享）+ 原文阅读工具（agent 按需）
- **章节归属的会话模型**：`书 → 章节 → 会话` + 独立会话
- AI 工具系统：原文只读工具 + agent 多步循环（tool-calling）
- 单个可编辑的默认 Assistant
- 最小 Provider 配置（密钥加密、掩码预览、按需揭示、测试连接）

### 延后（后续 Phase，结构上预留扩展位）

| 延后项                                     | 预留方式                                                  |
| ------------------------------------------ | --------------------------------------------------------- |
| 全书 / global 摘要 chip                    | `books` 预留 `global_summary` 相关列（本 Phase 不建）     |
| 文件系统工具（read/write/delete 授权目录） | 工具注册表 + agent 循环已在本 Phase 建好，后续只加函数    |
| 多 Assistant CRUD                          | `assistants` 表与 `conversations.assistant_id` 绑定已就位 |
| 全书检索 `searchBook`                      | 工具集预留扩展位                                          |

---

## 2. 技术栈

| 层             | 选择                                                                                                                 |
| -------------- | -------------------------------------------------------------------------------------------------------------------- |
| Shell          | Electron（electron-forge + Vite）                                                                                    |
| 语言           | TypeScript 6                                                                                                         |
| UI             | React 19                                                                                                             |
| 样式           | Tailwind CSS + **shadcn/ui（优先 Base UI 基底，避免 Radix 版本）**                                                   |
| AI 对话 UI     | **Vercel AI SDK v6 · UI**（`useChat` 等 hooks）+ 自定义 IPC transport 桥接 main                                      |
| i18n           | i18next（UI 文案全部走 key，组件不写死字符串）                                                                       |
| ePub 渲染      | epub.js（`flow: "scrolled"`, `spread: "none"`）                                                                      |
| 数据层         | **Drizzle ORM** + better-sqlite3 驱动（同步，跑在 main）                                                             |
| 迁移           | drizzle-kit 生成 SQL，应用启动时在 main 执行                                                                         |
| AI SDK（main） | **Vercel AI SDK v6**（`streamText` + tools + 多步 agent 循环）                                                       |
| 渲染层状态     | Zustand（**仅 UI 状态**）                                                                                            |
| 测试           | vitest                                                                                                               |
| Lint / Format  | oxlint + oxfmt（prek 预提交）                                                                                        |
| 运行时校验     | **Zod**（IPC 边界 / AI 工具入参 / 表单 / DB JSON 列校验；TS 类型经 `z.infer` 派生，`drizzle-zod` 由表生成行 schema） |
| 原生模块       | electron-rebuild **从第一天接入**（better-sqlite3）                                                                  |

---

## 3. 架构原则与进程边界

**核心原则（硬约束）：renderer 只负责渲染与交互逻辑，其他复杂业务全部放 main。**

- **main（厚）**：DB（Drizzle）、prompt 组装、provider 调用与流式、agent 循环与工具执行、密钥加解密、ePub 解析与原文读取、章节摘要生成队列。
- **renderer（薄）**：epub.js 渲染、选区/段落**原始文本**提取（唯一允许碰 DOM 之处，因只有渲染层有 DOM）、全部 UI、Zustand UI 状态。
- 二者通过 `contextBridge` 暴露的**类型化 `window.api`** 通信：请求/响应用 `ipcRenderer.invoke`，token / 工具步骤流用事件通道按 `streamId` 推回。
- **运行时校验（Zod）**：IPC 边界把来自 renderer 的入参视为**不可信**——main 全部经 Zod 解析后再处理，校验失败即拒绝并回结构化错误；AI 工具入参用 Zod `inputSchema`（AI SDK v6 原生）；表单与 DB JSON 列亦用 Zod 校验。schema 集中在 `shared/` 作单一事实源，TS 类型经 `z.infer` 派生。
- **AI 对话 UI**：renderer 用 **Vercel AI SDK UI** 的 `useChat`，配一个**自定义 IPC transport**——`useChat` 不走 HTTP，而是经 `window.api.ai.send` 发起、订阅 `ai.stream` 事件接收 **UI message stream**。main 用 `streamText(...).toUIMessageStream()` 产出，经 IPC 逐块推回。消息/分段端到端用 AI SDK UI 格式；**持久化 `UIMessage`**（AI SDK 最佳实践，类型置于 `shared/`，见 §5），发送时 main 用 `convertToModelMessages()` 派生临时 `ModelMessage` 喂模型。

> 边界说明：选区与周围段落的**原始文本提取**必须在 renderer（DOM 操作），但提取后**立即把原始文本交给 main**；token 计数、截断、chip 组装、prompt 拼接、agent 循环与工具执行等业务全部在 main，符合原则。renderer 的 `useChat` 只做 UI 状态与渲染，不含业务。

---

## 4. 模块 / 目录结构

```
src/
├── main/
│   ├── db/            # Drizzle schema、迁移执行、查询函数（repositories）
│   ├── epub/          # 导入解析(OPF/NCX)、按章读取原文、章节文本抽取
│   ├── ai/
│   │   ├── tools/     # 原文只读工具（getToc / readChapterText / getChapterSummary）
│   │   ├── prompt.ts  # prompt 组装（分层上下文 → messages）
│   │   ├── agent.ts   # streamText + tools 多步循环、流式编排、完成落库
│   │   └── summary.ts # 章节摘要懒生成队列
│   ├── secrets/       # safeStorage 加解密、掩码、揭示、测试连接
│   └── ipc/           # IPC handlers，定义 window.api 契约
├── renderer/
│   ├── components/
│   │   ├── Reader/    # epub.js 包装、选区浮动工具栏、选区/段落原始文本提取
│   │   ├── AIPanel/   # 会话 UI、输入栏、chips 渲染与检视、流式 + 工具步骤展示
│   │   ├── Library/   # 书库网格、导入触发
│   │   ├── Sidebar/   # TOC 导航树、会话列表（按书/章分组）
│   │   └── Settings/  # Provider 配置、默认 Assistant 编辑、阅读偏好
│   ├── store/         # Zustand（仅 UI 状态）
│   └── api/           # window.api 的类型化封装
└── shared/            # main↔renderer 共享：Zod schema(单一事实源)+z.infer 派生类型（Chip、IPC 契约、行类型）
```

---

## 5. 数据模型（Drizzle schema）

> schema 用 TS 定义，drizzle-kit 生成迁移。下面用 SQL 语义表达，便于审阅。
>
> **ID 策略**：app 生成的主键（`providers` / `assistants` / `chapters` / `conversations` / `messages`）一律用 **uuidv7**（时间有序，需 `uuid` 包；Node 内置 `randomUUID` 只产 v4）。`chapters` 虽对应 spine 项，但用 uuidv7 **代理键** + `UNIQUE(book_id, href)`（spine id 跨书不唯一）。仅 `books.id`（ePub 唯一标识，回退文件哈希）是 **ePub 自然键**，不生成。`messages` 仍保留 `seq` 保证同毫秒内会话级严格顺序。

```ts
// providers —— 新增
providers {
  id: text PK
  type: text NOT NULL            // 'openai' | 'anthropic' | 'google' | 'openai-compatible'
  label: text
  baseUrl: text
  apiKeyEncrypted: blob          // safeStorage 密文；未设为 NULL，绝不明文落库
  createdAt: integer
}

// assistants —— Phase 1 只存一行默认
assistants {
  id: text PK
  name: text NOT NULL
  systemPrompt: text
  providerId: text → providers.id
  model: text
  createdAt: integer
  // include_*_default 冻结（多 chip 后续阶段再加）
}

books {
  id: text PK                    // ePub unique id；缺失时回退文件哈希
  path: text NOT NULL
  title, author: text
  cover: blob
  toc: text                      // JSON，来自 NCX/OPF
  addedAt: integer
  // global_summary* 冻结
}

// chapters —— 结构性拉回，含懒生成摘要
chapters {
  id: text PK                    // uuidv7 代理键（spine id 跨书不唯一）
  bookId: text NOT NULL → books.id
  title: text
  orderIndex: integer
  href: text NOT NULL            // spine 项 href，用于 CFI→章节解析；书内唯一
  summary: text
  summaryStatus: text DEFAULT 'pending'   // pending|generating|ready|unavailable（DB CHECK）
  UNIQUE(book_id, href)
}

progress {
  bookId: text PK → books.id
  cfi: text NOT NULL
  updatedAt: integer
}

conversations {
  id: text PK
  bookId: text → books.id
  chapterId: text → chapters.id  // 可空（NULL = 独立会话）；一旦确认不可变
  assistantId: text → assistants.id
  title: text                    // 取自首条消息或用户命名
  createdAt, updatedAt: integer
}

// messages —— 镜像 AI SDK v6 UIMessage（id/role/parts/metadata）；按 AI SDK 持久化最佳实践
messages {
  id: text PK
  conversationId: text NOT NULL → conversations.id
  role: text NOT NULL            // 'system' | 'user' | 'assistant'（UIMessage 角色；工具调用/结果是 parts 内 tool-* 段）
  parts: text NOT NULL           // JSON: UIMessagePart[]（text|reasoning|tool-*|dynamic-tool|file|source-*|data-*|step-start）
  metadata: text                 // JSON: UIMessage.metadata（Zod messageMetadataSchema 校验）—— chips 快照 / token usage / 模型名
  seq: integer NOT NULL          // 会话内单调序号，保证重建顺序
  createdAt: integer
}
```

> **持久化用 UIMessage（AI SDK 最佳实践）**：`messages` 行镜像 AI SDK v6 `UIMessage`（`id`/`role`/`parts`/`metadata`），保留完整渲染保真度（reasoning / sources / 工具 I/O / 自定义 `data-*` 段）。`UIMessage` 类型置于 `shared/`（**非 renderer 私有**，main 与 renderer 共用的协议类型），故 main 持久化它不违背"业务在 main"原则；`ModelMessage` 仅是**每次请求的临时派生**，不落库。流程：① **加载会话**——存储的 `UIMessage[]` 直接作为 `useChat` 初始 `messages`，无需转换；② **发送**——main 用 `convertToModelMessages()` 派生 `ModelMessage[]`、在 §10 注入 chip 上下文后喂 `streamText`；③ **生成中**——`toUIMessageStream()` 经 IPC 推回 renderer 渲染，结束后把完整 UIMessage 落库。`metadata` 用 Zod `messageMetadataSchema` 校验，存 chips 快照 / token usage / 模型名。会话内顺序用单调 `seq`；`system` 角色一般不落库（系统提示来自 Assistant）。

---

## 6. 会话与章节模型

**层级**：`书 →(1..M) 章节 →(1..M) 会话`，外加**独立会话**（挂在书上、`chapterId = NULL`）。

**不可变归属**：会话一旦确认归属（某章 / 独立），用户不能再改。

**段落去重**：新划词若段落上下文与本会话**上一次插入的**相同，则本轮省略段落 chip（历史里已有，自然衔接）。

### 划词 → 会话路由规则

在 X 章划词点 AI：

1. 当前**活动会话**是**独立会话** 或 **绑定 X 章** → 追加进去。
2. 活动会话绑定**别的章**（归属不可变、章节摘要不匹配）→ 自动切到/新建 **X 章**的会话，并明确提示用户「已为《第 N 章》开启会话」。
3. **独立会话 = 跨章工作区**：无章节摘要，可接纳任意章节的段落上下文；通过显式「＋独立会话」入口创建（不经选区）。

> 语义自洽：章节绑定会话共享该章摘要，因此不接纳他章段落；独立会话无章节摘要，故可跨章。

---

## 7. 分层上下文策略

| 层                        | 内容                               | 注入方式               | 角色                                  |
| ------------------------- | ---------------------------------- | ---------------------- | ------------------------------------- |
| `selection` + `paragraph` | 划选原句 + 前1/当前/后1 段（逐字） | 每条消息持久化注入     | **必备锚点**：AI 精确知道用户在看什么 |
| `chapter` summary         | 懒生成的本章 AI 摘要               | 会话级共享、可降级省略 | **辅助 grounding**：本章梗概          |
| 原文阅读工具              | 全书任意章节/位置逐字原文          | agent 按需调用         | **深度**：要细读时自取                |

**Chip 抽象（shared）**——本 Phase 仅 `selection`/`paragraph` 两个必选 chip 进每条消息，`chapter` 为会话级共享：

```ts
type Chip = {
  id: "selection" | "paragraph"; // 可扩展 | 'chapter' | 'global'
  labelKey: string; // i18n key
  content: string; // 原始文本
  tokenCount: number; // main 侧估算
  required: boolean;
  enabled: boolean;
};
```

---

## 8. AI 工具系统

工具**全部在 main 执行**，agent 多步循环（Vercel AI SDK `streamText({ tools })`）也在 main 跑；renderer 只**渲染**工具调用步骤（折叠式「📖 读取《第 N 章》」指示，保持透明）。

### Phase 1 工具集（只读、限当前书）

```ts
getToc(): TocNode[]                                  // 让 agent 了解全书结构
readChapterText(chapterId, { offset?, maxChars? }):  // 逐字原文，分块返回
  { text, hasMore, nextOffset }                      // 防爆上下文窗口
getChapterSummary(chapterId): string                 // 取任意章摘要（懒生成，非仅当前章）
```

- **大章节防爆**：`readChapterText` 用 char-offset 分块返回 `hasMore` / `nextOffset`，agent 需更多时带 offset 续读。
- **「章节」单位定义**：一个章节 = 一个 **spine item**，但 `chapters.id` 用 uuidv7 **代理键**（spine id 跨书不唯一），书内由 `UNIQUE(book_id, href)` 唯一定位。epub.js 当前位置取自 `currentLocation().start.href`，经 `(bookId, href)` 解析到 `chapters.id`。AI 工具的 `chapterId` 即该代理 uuid（由 `getToc` 等返回）。TOC 仅用于侧栏导航；逻辑章节有时跨多个 spine 项，但摘要与会话归属一律以 spine 项为单位（最稳定）。
- **工具入参校验**：每个工具用 Zod `inputSchema` 定义参数（AI SDK v6 原生），main 执行前自动校验、非法即拒。

> 红利：本 Phase 已建好「工具注册表 + agent 循环」基础设施，后续加文件系统工具只需往注册表加函数，零返工。

---

## 9. 选区 → AI 数据流

1. **renderer**：`rendition.on("selected")` 拿 `cfiRange`；从锚点向上取最近块级元素 + 前1/后1 段**原始文本**；浮动工具栏出现。
2. **renderer → main** `api.ai.buildChips(raw)`：main 算 token、返回 `Chip[]`；输入栏渲染 chips（可点击检视全文）；若点了预设，则把模板**预填**输入框（可改可直接发）。
3. 用户提交 → `api.ai.send({ conversationId, chips, userText, presetId })`（按 §6 路由确定/新建会话）。
4. **main**：组装 prompt（§10）→ 解密取 key → `streamText` 流式调用（带工具，可多步）。
5. **main** 经 `ai.stream`（按 `streamId`）推：token delta、工具调用步骤、完成、错误。renderer 实时渲染。
6. **完成**：main 落库为 UIMessage：user 消息（chips 快照入 `metadata`）+ assistant 消息（含 tool-\* parts，工具 I/O 内联）；更新 `conversations.updatedAt`。
7. **出错**：main 推 error 事件，renderer 在该消息内联报错；**不把半截结果当成功落库**。

---

## 10. Prompt 组装（main）

```
[system prompt（来自默认 Assistant）]
---
[若 chapter 摘要 ready] ## 本章概要：{chapter title}
{chapter summary}
---
## 周围上下文
{前一段 + 当前段 + 后一段}
---
## 选中文本
{逐字选区}
---
[用户消息文本]
```

- 顺序宏 → 微。`chapter` 未 ready / `unavailable` 时整段省略（优雅降级）。
- 前接**会话历史**。**历史上下文策略（Phase 1）**：旧轮次**原样带**其当初的段落上下文（实现最简、最忠实；长对话 token 增长由用户从 chip token 数可见）。历史裁剪/摘要留作后续。

---

## 11. 章节摘要懒生成

main 后台队列，**不阻塞**阅读与对话：

1. 在 X 章**第一次开会话 / 首次 AI 发送**时查 `chapters.summaryStatus`。
2. 若 `pending` → 置 `generating`、入队：main 抽取该章正文 → 调 AI 摘要 → 存 `summary`、置 `ready`。
3. 摘要未就绪时，`chapter` chip 显示「生成中」并从本轮 prompt 省略；就绪后续轮自动带上。
4. 生成失败 → `unavailable`，chip 禁用 + tooltip 说明。
5. 之后该章**所有**会话复用这份缓存摘要。

> 摘要生成默认用 Assistant 配置的 provider/model；独立「摘要模型」设置留作后续。

---

## 12. Provider 与密钥安全

- 所有 AI 调用在 **main**；renderer 经 IPC 流式接收。
- API key 用 Electron **safeStorage**（OS 钥匙串）加密，存 `providers.apiKeyEncrypted`（密文），**不进渲染进程、不明文落库**。
- 渲染层展示：**掩码预览**（`sk-…1234`）默认；「👁 显示」走 IPC 取明文临时展示；「测试连接」免揭示验证。
- `api.providers.{ list, upsert, reveal, test }`。

---

## 13. Assistant

Phase 1 内置**单个可编辑默认 Assistant**（name / systemPrompt / providerId / model 可改）。会话照常绑定 `assistantId`（为将来多 Assistant 零返工），但不做多个的增删管理 UI。

---

## 14. epub.js 集成细节（renderer）

- `flow: "scrolled"`、`spread: "none"`；main 经 IPC 给整书 `ArrayBuffer`，`ePub(arrayBuffer)` 加载（**Phase 1 不引入自定义协议**，绕开 CSP；按需懒加载留作优化）。
- 进度：`rendition.on("relocated")` → 防抖后 `api.progress.save(bookId, cfi)`；打开时 `rendition.display(cfi)` 恢复。
- 章节解析：`currentLocation().start.href` → 映射 `chapters`（spine 项）→ 当前 `chapterId`（驱动会话路由与懒生成）。
- 选区提取：`rendition.on("selected")` 拿 `cfiRange`；DOM 向上取块级元素 + 前1/后1 段原始文本 → 交 main。

**导入时（main）**：解析 OPF/NCX → 写 `books`（title/author/cover/toc）+ 批量写 `chapters`（id=spine id, href, orderIndex, title 由 TOC 映射）；摘要字段留 `pending`，**不在导入时生成**。

---

## 15. IPC 契约（`window.api` 草图）

```ts
library.import()            // 选 ePub、解析、入库
library.list()
library.open(bookId)        // → 元数据 + spine/toc + ArrayBuffer
progress.get(bookId) / progress.save(bookId, cfi)
conversations.listByBook(bookId) / create(...) / get(id)
messages.listByConversation(conversationId)
ai.buildChips(raw)          // → Chip[]（含 tokenCount）
ai.send({ conversationId, chips, userText, presetId }) // → streamId（由 useChat 自定义 transport 调用）
ai.stream(streamId)         // 事件流：UI message stream chunk（AI SDK UI 格式）/ done / error
providers.list() / upsert(...) / reveal(id) / test(id)
assistant.getDefault() / update(...)
reader.getPrefs() / setPrefs(...)   // 字号、行高、最大宽度（注入 epub.js CSS）
```

---

## 16. 错误处理与降级

- 未配置 provider/key：发送前友好引导去 Settings，而非静默失败。
- 章节摘要生成失败 → `unavailable`，chip 禁用 + tooltip。
- 流式 / 工具调用出错 → 该消息内联报错，不把半截结果当成功落库。
- ePub 解析失败 → 导入报错，不进库。

---

## 17. 测试策略（vitest）

业务集中在 main，便于单测：

- 纯函数单测：prompt 组装、段落去重、章节解析（href→id）、`readChapterText` 分页边界、Drizzle 迁移升级。
- DOM 提取逻辑抽成可测函数（jsdom + fixture）。
- IPC 契约靠 `shared/` 类型在编译期兜底；运行期靠 Zod 校验。
- Zod schema 单测：IPC 入参、工具 `inputSchema`、JSON 列的合法/非法边界用例。

---

## 18. 工具链与依赖

- **electron-rebuild 从第一天接入**（better-sqlite3 原生模块，避免打包期踩坑）。
- 待装：`drizzle-orm` + `better-sqlite3` + `drizzle-kit`、`epub.js`、**AI SDK v6**（`ai@6` + `@ai-sdk/react` + provider 包 `@ai-sdk/openai`/`@ai-sdk/anthropic`/`@ai-sdk/google`）、`zustand`、`uuid`(v7)、`zod` + `drizzle-zod`、`tailwindcss` + shadcn/ui（Base UI 基底）依赖。`react` / `i18next` / `vitest` / `oxlint` / `oxfmt` 已在。

---

## 19. 应用布局

```
┌──────────────┬────────────────────────┬───────────────┐
│ Sidebar      │ Reader                 │ AI Panel      │
│ 书库          │ epub.js 滚动渲染         │ Assistant     │
│ TOC(当前书)   │                        │ 会话历史        │
│ 会话列表       │ [选区浮动工具栏]          │ 输入栏          │
│ (按书/章分组)  │                        │ [chips][文本框] │
└──────────────┴────────────────────────┴───────────────┘
```

AI 面板可折叠；折叠时选区工具栏仍出现，点 AI 动作会展开面板。

---

## 20. 已解决的原 SPEC Open Questions

1. **会话范围** → 章节归属模型（书→章→会话 + 独立会话），显式多会话、默认延续、归属不可变（§6）。
2. **工具栏 AI 动作** → 单入口「AI 问」+ 预设预填模板（解释/翻译/概括），一条代码路径（§9）。
3. **better-sqlite3 rebuild** → electron-rebuild 第一天接入（§18）。

---

## 21. 后续 Phase（预告，非本次范围）

- 全书 / global 摘要 chip
- 文件系统工具（沙箱化 read/write/delete + 授权目录）
- 多 Assistant CRUD + 会话切换
- 全书检索工具 `searchBook`
- 历史上下文裁剪 / 摘要、自定义协议懒加载、独立摘要模型设置
