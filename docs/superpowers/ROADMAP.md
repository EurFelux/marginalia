# Marginalia · 开发进度总览（ROADMAP）

> **这是开发进度的单一真相源。** 里程碑状态、当前焦点、待办 backlog 都看这里；实现细节去对应的 `specs/` 设计文档与 `plans/` 实现计划。
>
> **维护约定**：每次合并分支（走 `finishing-a-development-branch`）时**顺手更新本文件**——挪动里程碑状态、勾掉已完成、新增发现的待办。别让进度状态散回各文档的散文里。
>
> 更新日期：2026-06-02

---

## 当前焦点

**最小可用竖切已交付并合并**（PR #6，2026-06-02）：导入 → 读 → 选 → 问 → **真模型流式回复**，端到端可用。

**RA1-full 已交付并合并**（epub.js 真实渲染 + CFI 锚定）：

- **Plan A（✅）**：`@marginalia/virtual-docs` 包——react-virtuoso 薄封装 + 自适应高度 iframe + 选区事件，epub-agnostic。
- **Plan B（✅）**：app 集成——`readEpubBytes` IPC + epubjs 胶水（`ePub`/`section.render`/`EpubCFI`）+ `EpubReader` 替换 ReaderPane + CFI 进度/恢复/跳章/当前章 + 偏好注入（`!important` 覆盖 ePub 自带样式）+ 选区桥（块级取段 + `cfiRange`，AI 契约零改动）。真书手测通过；执行中修的集成 bug（恢复缓存、字体覆盖、子目录 OPF 跳章）已落地。

**下一目标候选**：RA3 + M-b（标注，依赖 CFI——现已解锁，`cfiRange` 已捕获）、RA4 收尾（M-d/M-c）、类型设计债清理、RA1-full「精度/内存 pass」（图片延时 / 当前章高亮滞后 / 长书 section 内存，见 backlog）。

---

## 里程碑 / 工作单元状态

图例：✅ 完成 · 🟡 部分 · 🔴 未开始

### 主进程

| 单元    | 名称                                                          | 状态 | 备注                                         |
| ------- | ------------------------------------------------------------- | ---- | -------------------------------------------- |
| MA1–MA5 | DB/IPC 脊柱 · ePub · Provider/密钥 · 会话/Prompt · 流式 Agent | ✅   | headless 测试覆盖                            |
| M-a     | 流式 IPC transport                                            | ✅   | 竖切落地（`ai:send`/`abort`/`chunk` + pump） |
| M-p     | preload / `window.api` 契约                                   | ✅   | 竖切落地（library/content/settings/chat/ai） |
| M-b     | annotations 持久化 + IPC + CFI                                | 🔴   | RA3 前置                                     |
| M-c     | 跨章 `routeConversation(chapterIds[])`                        | 🔴   | 单章已支持；`chapterIds[]` 待扩展            |
| M-d     | `books.summary` 全书摘要                                      | 🔴   | 章节摘要已成；全书 schema/IPC 待补           |

### 渲染层（RA 轨）

| 单元     | 名称                                            | 状态 | 备注                                                                                                                       |
| -------- | ----------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------- |
| RA0      | 渲染层地基（三栏 / Tailwind / Query / zustand） | ✅   | 竖切重建，替换 Forge 模板桩                                                                                                |
| RA1-min  | 书库导入 + 静态正文 + TOC 章节                  | ✅   |                                                                                                                            |
| RA1-full | epub.js 真实渲染 / 分页 / CFI                   | ✅   | Plan A + Plan B 落地：真实渲染 + CFI 进度/恢复/跳章/当前章 + 选区桥，连续滚动；分页以连续滚动替代；精度/内存优化见 backlog |
| RA2      | 选区 → 工具栏 → chip → 流式聊天                 | ✅   | CFI 选区落地（epub-selection 块级取段 + `cfiRange`；AI 契约零改动）                                                        |
| RA3      | 标注与笔记 UI                                   | 🔴   | 依赖 M-b（待）；RA1-full ✅ 已就绪，`cfiRange` 已捕获                                                                      |
| RA4      | 摘要查看 + 跨章会话                             | 🟡   | 章节摘要 pill ✅；全书摘要 / 跨章 🔴                                                                                       |
| RA5      | Provider / 设置 UI                              | 🟡   | Anthropic ✅；多 provider 类型 🔴                                                                                          |
| D1       | 打包 / 迁移路径                                 | 🔴   | `electron-forge extraResources` 复制迁移 SQL                                                                               |

> 全量分解与依赖 DAG 见 [`renderer-track-decomposition`](plans/2026-06-01-marginalia-renderer-track-decomposition.md)。

---

## Backlog（待办，按主题）

> 收口自各 spec/plan 的「刻意推迟」段与 `*-deferred-followups` 记忆。细节看「来源」列。

### 类型设计债（趁渲染层刚接 preload、迁移成本低，优先清）

| 项                                                                   | 来源               |
| -------------------------------------------------------------------- | ------------------ |
| `ProviderDto` 三布尔扁平态 → `key` 判别联合（非法态不可表示）        | ma3-deferred       |
| `ConversationDto` 章节/独立判别联合 + DB `CHECK`                     | ma4-deferred       |
| `conversations.assistantId` 收紧 `NOT NULL`（连迁移 + 测试 fixture） | ma4-deferred       |
| `Chip.required`/`enabled` 闭合联合（UI toggle 落地时）               | ma4 / ma5-deferred |
| `ChatModel` → 直接 `import type { LanguageModelV3 }`                 | ma3-deferred       |
| 具名 `ReadingTools` 类型 + `InferUITools` 收紧 chunk                 | ma5-deferred       |

### 设置 / 产品

| 项                                                       | 状态 | 来源                               |
| -------------------------------------------------------- | ---- | ---------------------------------- |
| **最大并发数设置**（后台模型调用全局上限，默认建议 2–3） | 🔴   | vslice spec §10 / core §11         |
| 可配置代理设置（自定义地址 / PAC / 按 provider 覆盖）    | 🔴   | vslice spec §8.1 / §10             |
| `stepLimit` 设置项（现硬编默认 5）                       | 🔴   | ma5-deferred #8                    |
| 独立「摘要模型」设置                                     | 🔴   | core §11                           |
| i18n（多语言）                                           | 🔴   | 竖切未上；UP1 用过 i18next         |
| **颜色模式**（dark / light / system 三档，跟随系统）     | 🔴   | 用户 2026-06-02 指定               |
| `metadata.usage` 落库（token 用量）                      | 🔴   | ma5-deferred #4                    |
| 结构化 `reason` 分类（现自由字符串，UI 要 i18n 时再做）  | 🔴   | ma5-deferred #6                    |
| onboarding/landing 引导用户先配 provider + 开自动摘要    | 🔴   | 记忆 onboarding-guide-auto-summary |

### 基建 / 重构

| 项                                                                                                                                                                                                                                                                                                                                                 | 状态 | 来源                 |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------- |
| **`preferences` 持久化表**：DB 层每条记 `key(text)` + `value(json text)`；服务层类型化 `key → JSONValue`，持久化用户偏好。承载现为会话内/临时态的 `lastHighlightStyle`（RA3）、**颜色模式**、`ReaderPrefs`（字号/行距/宽度）等。                                                                                                                   | 🔴   | 用户 2026-06-03 指定 |
| **渲染层 UI 系统重构到 shadcn 基底**：底层全部用 shadcn 基础组件、按需调样式。现状：竖切重建 renderer 时未 scaffold shadcn（无 `components.json`/`components/ui`，组件手搓 Tailwind+`cn`；`cva`/`clsx`/`tailwind-merge` 已装但未当组件库用；UP1 原型用了完整 shadcn）。`components/ui/kbd.tsx` 是首个 ui 组件；注意别与现有 Tailwind v4 配置冲突。 | 🔴   | 用户 2026-06-03 指定 |
| **自绘窗口 chrome / 无系统 titlebar**：`titleBarStyle:"hidden"` + mac `trafficLightPosition`（红绿灯让位）+ 自定义 header（mac 加 `pl-20` 等）。要做完善跨平台方案：mac/win 控件差异、拖拽区 `-webkit-app-region: drag`、全屏态。用户试过的 WIP 已 `git stash`（`stash@{0}`）。                                                                    | 🔴   | 用户 2026-06-03 WIP  |

### 接缝 / 小修

| 项                                                                                                                                                                                    | 状态           | 来源                                                                  |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | --------------------------------------------------------------------- |
| 跨章选区 → 独立会话 + best-effort 组合摘要（M-c 的 UI 侧）                                                                                                                            | 🔴             | ma4-deferred #8                                                       |
| `textOfParts` 历史回放丢弃 assistant 的 tool/reasoning part                                                                                                                           | 🟡 Phase1 有意 | ma4 #5 / ma5 #9                                                       |
| `conversations:create` FK 友好预检（现抛原始 SQLITE_CONSTRAINT）                                                                                                                      | 🔴 cosmetic    | ma4-deferred #7                                                       |
| 嵌套 TOC 层级目录渲染（现 `content.chapters` 扁平）                                                                                                                                   | 🔴             | vslice p3                                                             |
| 章内完整分页（`hasMore` 续读 `nextOffset`）                                                                                                                                           | 🔴             | vslice p3 / p4                                                        |
| 会话历史初值（重开会话载入 `messages.list-by-conversation`）                                                                                                                          | 🔴             | vslice p4                                                             |
| 虚拟滚动高度稳定性（向上滚闪 + 图片 section 高度跳变/延时）→ 估高 / 缓存测高占位 / 图片尺寸策略                                                                                       | 🔴             | RA1-a 手测；Plan B 真实 ePub 后针对性调                               |
| 当前章高亮滞后（用 react-virtuoso `rangeChanged.startIndex` 含 overscan、非视口顶 section；短章≈滞后一整章）→ VirtualDocs 加 IntersectionObserver 精确上报视口顶 section              | 🔴             | Plan B T5 真书手测确认；并入「精度 pass」                             |
| 长书 `section.document` 常驻内存（epub-book 解析后不 `unload` 以供 CFI，长书全程滚动后所有访问过的 section 文档常驻 JS 堆）→ 远离视口的节 `unload`、需要时重渲                        | 🔴             | spec「长书内存有界」成功判据；Plan B 刻意推迟，并入「精度/内存 pass」 |
| 全 schema 级 FK `ON DELETE CASCADE` 策略（`chapters`/`progress`/`conversations`/`messages`/`annotations` 等所有 `references(books.id)` 均无 cascade；删书功能落地前统一定，免孤儿行） | 🔴             | RA3 T1 代码审查；删书 IPC 尚未实现，暂无孤儿                          |

### 已由竖切解决（存档，勿重复开）

M-a 流式 IPC · M-p 契约闭合 · `SendInput` Zod schema · `SendDeps`/`SummaryDeps` 生产工厂 · transport consume/cancel `callerStream` · `getChapterSummary` 补 `title` · chip 快照投影 · `presetId` 模板预填（解释/翻译/概括）· 工具章节 `id`/`href` 容错 · 摘要生成与发消息解耦（自动/手动触发）。

---

## 文档地图

- **`specs/`**：产品与技术设计——核心阅读闭环（Phase 1）、UP1 UI 原型、最小可用竖切。
- **`plans/`**：里程碑 bite-sized 实现计划——MA1–MA5、竖切 P1–P4、RA 轨任务分解。
- **记忆**（`~/.claude/.../memory/`）：`*-deferred-followups`（MA3/4/5 细节）、各类 feedback/project 记忆（见 `MEMORY.md` 索引）。
