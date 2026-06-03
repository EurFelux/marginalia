# Marginalia · 开发进度总览（ROADMAP）

> **这是开发进度的单一真相源。** 里程碑状态、当前焦点、待办 backlog 都看这里；实现细节去对应的 `specs/` 设计文档与 `plans/` 实现计划。
>
> **维护约定**：每次合并分支（走 `finishing-a-development-branch`）时**顺手更新本文件**——挪动里程碑状态、勾掉已完成、新增发现的待办。别让进度状态散回各文档的散文里。
>
> 更新日期：2026-06-03

---

## 当前焦点

**最小可用竖切已交付并合并**（PR #6，2026-06-02）：导入 → 读 → 选 → 问 → **真模型流式回复**，端到端可用。

**RA1-full 已交付并合并**（epub.js 真实渲染 + CFI 锚定）：

- **Plan A（✅）**：`@marginalia/virtual-docs` 包——react-virtuoso 薄封装 + 自适应高度 iframe + 选区事件，epub-agnostic。
- **Plan B（✅）**：app 集成——`readEpubBytes` IPC + epubjs 胶水（`ePub`/`section.render`/`EpubCFI`）+ `EpubReader` 替换 ReaderPane + CFI 进度/恢复/跳章/当前章 + 偏好注入（`!important` 覆盖 ePub 自带样式）+ 选区桥（块级取段 + `cfiRange`，AI 契约零改动）。真书手测通过；执行中修的集成 bug（恢复缓存、字体覆盖、子目录 OPF 跳章）已落地。

**RA3 + M-b 已交付并合并**（标注与笔记，2026-06-03）：annotations 表/repository（headless 测）+ IPC/preload + CFI 高亮渲染（`ignoreClass` 防污染 + `rangeFromCfi`）+ 点击编辑（5 色 + 下划线，「高亮标记」即时套用上次样式）+ 段内笔记 modal（原文引用、⌘/Ctrl+Enter）+ 侧栏标注列表（阅读序 + 跳转）。真书手测通过；最终综合审查修掉跨任务接缝（笔记长文滚动丢失、样式栏死代码）。

**RA5 已交付并合并**（多 provider + baseUrl + 双栏设置 + 拉模型）：providers.models 字段 + seed 默认值 + `fetchProviderModels` + `list-models` IPC + 双栏 Settings UI 替换旧 modal；provider `baseUrl` 可配自定义 API 端点。

**i18n 已交付**（双语 zh-CN/en，2026-06-03）：`@shared/i18n` 纯逻辑 + **扁平点分键** locale（i18next-cli extract/lint/status 工具链，`defaultNS:false`/`keySeparator:false` 便于全文搜索）；主进程 vanilla i18next 本地化「自产」错误消息（honest-error 透传不动）+ 渲染层 react-i18next（**跟随系统语言** + 偏好持久化 + 设置「外观」语言切换 + `<html lang/dir>`）；**全量 UI 文案抽取**（160 键、zh-CN/en 各 100%）；`provider` 提为 **`terms.provider`** 术语（zh「模型服务商」）经 `$t()` 嵌套复用；物理 Tailwind 类 → **逻辑类**（RTL-ready，LTR 渲染零变化）。详见 `specs/2026-06-03-i18n-design.md` / `plans/2026-06-03-i18n.md`。

**书库拖拽导入已交付**（2026-06-03）：拖 ePub 到书库即导入——`useEpubDrop` 拖拽状态机 + `DropOverlay` 居中投放卡 + `epub-drop` 纯 helper（过滤/basename）+ `library.pathForFile`（preload 经 `webUtils.getPathForFile`）+ sonner toast 即时反馈；文案已 i18n 化。详见 `specs/2026-06-03-library-drag-drop-import-design.md`。**待办**：导入卡顿（主进程同步解析 ePub）待挪 worker。

**书库封面墙已交付**（Apple Books 风，2026-06-03）：书库改为纯封面墙——已存的 `books.cover` blob 经自定义 `cover://` 协议（privileged/secure scheme，`protocol.handle` 读 blob 返图片）喂给 `<img>`，无封面的书用「截断书名+作者」生成确定性配色的兜底 tile（`coverGradientClass` 从精选 Tailwind 渐变调色板按 hash 取）。`listBooks` 加 SQL 派生 `hasCover`（`is not null and length>0`）且不再载 cover blob。纯逻辑（`cover-bytes`/`cover-palette`）headless 测，组件手测。详见 `specs/2026-06-03-library-cover-grid-design.md`。

**书库右键删书已交付**（2026-06-03）：封面墙每本书加纯右键 Context Menu（仅「删除」项，destructive），点删除弹 AlertDialog 确认（不可逆：级联删 DB + unlink epub 副本），确认后调既有 `library:delete` IPC（#9 P3 后端）→ 失效刷新书库 + toast（失败透传真实错误）。新增 `components/ui/context-menu.tsx`/`alert-dialog.tsx`（仿 dialog/select 包装 `@base-ui/react`，未跑 CLI）；`BookCover` 管菜单/确认本地态 + `onDelete` 回调，`LibraryView` 管 mutation。连带修暗色 `--destructive` 偏暗的可访问性问题（→ shadcn 现行 `oklch(0.704 …)`）。详见 `specs/2026-06-03-library-context-menu-delete-design.md`。

**#9 DB 生命周期规则进行中**：spec（`specs/2026-06-03-db-lifecycle-rules-design.md`）把五块 DB 债定义成规则并拆成 4 份 plan。**P1 章节摘要派生态**（去 `summary_status` 列、状态读时派生）、**P2 AI 终态模型**（`messages.status` 终态 + usage/error 落库 + 尾-user 崩溃派生）与 **P4 迁移打包**（extraResource 复制迁移 SQL 进 `resources/migrations` + 生产读 `process.resourcesPath`；连带修复 Forge Vite plugin 把整个 node_modules 排除出 asar、导致 native 模块 better-sqlite3 缺失的打包缺陷——自定义 ignore 保留 better-sqlite3 运行时子树 + `auto-unpack-natives` 解包 `.node`，打包冒烟验证迁移建全表/provider 初始化）**已实现**；**P3 删除+文件簇**（6 个 book-owned FK 全 `ON DELETE CASCADE`＋表重建迁移；ePub 导入复制为 app 自有副本 `userData/books/<sha256(bookId)>.epub`、删 `books.path` 列改派生路径、缺失抛 `EpubFileMissingError`→重导；`deleteBook` 先 DB 级联删后 best-effort 删文件＋`library:delete` IPC＋preload）亦**已实现**——至此 **#9 四份 plan（P1–P4）全部落地**（删书 / relink UI 属 RA 轨）。

**IPC 契约注册表重构已交付并合并**（#8，2026-06-03）：契约 map `C`（`src/shared/ipc.ts`）为单一源——每通道一条 `def(channel,kind,input schema,output 类型载体)`，main handler 与 preload 两端引用同一 `C.x`，使类型漂移变编译错误、通道名漂移结构上不可能。`bind(C.x,fn)` 产出纯数据 `Binding` + `register()` 唯一碰 `ipcMain`（绕开 `ELECTRON_RUN_AS_NODE` 下 `ipcMain` 为 undefined 的测试约束）；preload 改 `createApi(注入依赖)` 纯函数 + `invoker(C.x)`，类型由契约派生、零手写标注、`window.api` 形状不变（renderer 零改动）。output 用幽灵类型载体（保持原 `handle` 不校验 output 的行为）；判别联合返回的 handler 加显式返回注解配合 `bind` 的 `NoInfer<O>`（output 权威来自契约）。删旧 `handle` 与 `IPC` 常量对象。三道纯数据漂移测试兜底（契约完整性 / bindings 覆盖 / preload 覆盖）。rebase 到当前 main 时把 #9 P3 的 `library:delete` 并入 `C`/binding/preload。详见 `specs/2026-06-03-ipc-contract-registry-design.md` / `plans/2026-06-03-ipc-contract-registry.md`。

**阅读精度 / 长书内存 pass 已交付**（2026-06-03）：RA1-full 刻意推迟的三项渲染债收口——① `SectionFrame` 等图片（`img.decode()`）/字体（`fonts.ready`）就绪后一次性上报稳定高度（超时兜底）+ `VirtualDocs` 测高缓存占位，根除图片加载致的向上滚跳；② `VirtualDocs` 按 `active range ± keepDistance` 主动回调 `onUnloadSection` + `epub-book.unloadSection`（`section.unload()`），长书内存有界（CFI 操作只在可见 section，故 unload 远离视口安全）；③ `VirtualDocs` IntersectionObserver + 纯函数 `topVisibleIndex` 精确上报视口顶 `onTopSectionChange`，当前章高亮跟手。纯逻辑（`topVisibleIndex`/`sectionsToUnload`/`estimateHeight`）headless 单测，渲染真书手测验收。**关键坑**：`virtual-docs` 工作区源码包**不过 React Compiler**（经 node_modules 软链被 babel `/node_modules/` exclude），传给 react-virtuoso 的回调（尤其 `scrollerRef`）必须手动 `useCallback` 稳定身份，否则白屏（无限渲染）。详见 `specs/2026-06-03-reader-precision-memory-pass-design.md` / `plans/2026-06-03-reader-precision-memory-pass.md`。

**下一目标候选**：**类型设计债清理**（已定为下一步）、RA4 收尾（M-d 全书摘要 / M-c 跨章）。颜色模式（dark / light / system）✅、`preferences` 持久化表 ✅、RA5 ✅、RA1-full「精度/内存 pass」✅ 均已完成。

---

## 里程碑 / 工作单元状态

图例：✅ 完成 · 🟡 部分 · 🔴 未开始

### 主进程

| 单元    | 名称                                                          | 状态 | 备注                                                  |
| ------- | ------------------------------------------------------------- | ---- | ----------------------------------------------------- |
| MA1–MA5 | DB/IPC 脊柱 · ePub · Provider/密钥 · 会话/Prompt · 流式 Agent | ✅   | headless 测试覆盖                                     |
| M-a     | 流式 IPC transport                                            | ✅   | 竖切落地（`ai:send`/`abort`/`chunk` + pump）          |
| M-p     | preload / `window.api` 契约                                   | ✅   | 竖切落地（library/content/settings/chat/ai）          |
| M-b     | annotations 持久化 + IPC + CFI                                | ✅   | annotations 表/repository（headless 测）+ IPC/preload |
| M-c     | 跨章 `routeConversation(chapterIds[])`                        | 🔴   | 单章已支持；`chapterIds[]` 待扩展                     |
| M-d     | `books.summary` 全书摘要                                      | ✅   | 派生态（不持久化 status）+ 整本喂 + 侧栏书卡 UI       |

### 渲染层（RA 轨）

| 单元     | 名称                                            | 状态 | 备注                                                                                                                       |
| -------- | ----------------------------------------------- | ---- | -------------------------------------------------------------------------------------------------------------------------- |
| RA0      | 渲染层地基（三栏 / Tailwind / Query / zustand） | ✅   | 竖切重建，替换 Forge 模板桩                                                                                                |
| RA1-min  | 书库导入 + 静态正文 + TOC 章节                  | ✅   |                                                                                                                            |
| RA1-full | epub.js 真实渲染 / 分页 / CFI                   | ✅   | Plan A + Plan B 落地：真实渲染 + CFI 进度/恢复/跳章/当前章 + 选区桥，连续滚动；分页以连续滚动替代；精度/内存优化见 backlog |
| RA2      | 选区 → 工具栏 → chip → 流式聊天                 | ✅   | CFI 选区落地（epub-selection 块级取段 + `cfiRange`；AI 契约零改动）                                                        |
| RA3      | 标注与笔记 UI                                   | ✅   | CFI 高亮(5 色+下划线)/点击编辑/笔记 modal/侧栏列表；即时套用上次样式                                                       |
| RA4      | 摘要查看 + 跨章会话                             | 🟡   | 章节摘要 pill ✅；全书摘要书卡 ✅；跨章 🔴                                                                                 |
| RA5      | Provider / 设置 UI                              | ✅   | 多 provider + baseUrl + 双栏设置 + 拉模型 ✅                                                                               |
| D1       | 打包 / 迁移路径                                 | ✅   | extraResource 复制迁移 SQL + 自定义 ignore/auto-unpack 把 better-sqlite3 native 打进 asar；打包冒烟验证迁移建全表（#9 P4） |

> 全量分解与依赖 DAG 见 [`renderer-track-decomposition`](plans/2026-06-01-marginalia-renderer-track-decomposition.md)。

---

## Backlog（待办，按主题）

> 收口自各 spec/plan 的「刻意推迟」段与 `*-deferred-followups` 记忆。细节看「来源」列。

### 类型设计债（趁渲染层刚接 preload、迁移成本低，优先清）

> 1/2/3/5 已清（分支 `chore/type-design-debt`，2026-06-03；spec/plan 见 `2026-06-03-type-design-debt-cleanup*`）。4/6 当前**零消费方**，延后到各自消费方（UI chip toggle / 需要精确 tool-result chunk）落地时按实际需求收敛——避免对不存在的消费方猜类型形状。

| 项                                                                      | 状态 | 来源               |
| ----------------------------------------------------------------------- | ---- | ------------------ |
| `ProviderDto` 三布尔扁平态 → `key` 判别联合（非法态不可表示）           | ✅   | ma3-deferred       |
| `ConversationDto` 章节/独立判别联合 + `book_id`/`assistant_id` NOT NULL | ✅   | ma4-deferred       |
| `ChatModel` → 直接 `import type { LanguageModelV3 }`                    | ✅   | ma3-deferred       |
| `Chip.required`/`enabled` 闭合联合（UI toggle 落地时收敛）              | 🔴   | ma4 / ma5-deferred |
| 具名 `ReadingTools` 类型 + `InferUITools` 收紧 chunk（需精确 chunk 时） | 🔴   | ma5-deferred       |

### 设置 / 产品

| 项                                                                                                                                                                                                                             | 状态 | 来源                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---- | -------------------------------------------------------------------------------------------------------------------- |
| **最大并发数设置**（后台模型调用全局上限，默认建议 2–3）                                                                                                                                                                       | 🔴   | vslice spec §10 / core §11                                                                                           |
| 可配置代理设置（自定义地址 / PAC / 按 provider 覆盖）                                                                                                                                                                          | 🔴   | vslice spec §8.1 / §10                                                                                               |
| `stepLimit` 设置项（现硬编默认 5）                                                                                                                                                                                             | 🔴   | ma5-deferred #8                                                                                                      |
| 独立「摘要模型」设置                                                                                                                                                                                                           | 🔴   | core §11                                                                                                             |
| i18n（多语言）                                                                                                                                                                                                                 | ✅   | zh-CN/en；跟随系统 + 偏好持久化；主进程错误 + 渲染层全量抽取（160 键 100%）；RTL-ready；2026-06-03                   |
| **颜色模式**（dark / light / system 三档，跟随系统）                                                                                                                                                                           | ✅   | 用户 2026-06-02 指定                                                                                                 |
| 书页暗色无法覆盖带 `!important` 硬编码颜色的 ePub（颜色模式 v1 已知局限）                                                                                                                                                      | 🔴   | 颜色模式 v1 已知局限                                                                                                 |
| 独立阅读主题（sepia / 与外壳解耦的夜间档）                                                                                                                                                                                     | 🔴   | 颜色模式后续扩展                                                                                                     |
| `metadata.usage` 落库（token 用量）                                                                                                                                                                                            | 🔴   | ma5-deferred #4                                                                                                      |
| 结构化 `reason` 分类（`reason` 现为自由字符串）                                                                                                                                                                                | 🔴   | ma5-deferred #6；i18n 已落地但选择在主进程产出时本地化 `reason` 串，结构化分类本身未做（仅渲染层需按码重译时才需要） |
| onboarding/landing 引导用户先配 provider + 开自动摘要                                                                                                                                                                          | 🔴   | 记忆 onboarding-guide-auto-summary                                                                                   |
| **书库样式改善 + 书封面**：✅ Apple Books 风纯封面墙——`cover://` 协议喂 `books.cover` 给 `<img>`，无封面用确定性配色兜底 tile；`listBooks` 派生 `hasCover` 且不载 blob。详见 `specs/2026-06-03-library-cover-grid-design.md`。 | ✅   | 用户 2026-06-03 指定                                                                                                 |
| **provider `baseUrl` 设置**：每个 provider 可配自定义 API 端点（OpenAI 兼容代理 / 自建网关等）；关联 RA5 provider UI。                                                                                                         | ✅   | 用户 2026-06-03 指定                                                                                                 |

### 基建 / 重构

| 项                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 状态 | 来源                             |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- | -------------------------------- |
| **`preferences` 持久化表**：✅ DB `key(text)`+`value(json)` + Zod 单一源 `PREFERENCE_SCHEMAS` + IPC/preload + 启动 hydrate/变更落盘。已承载 `lastHighlightStyle`/`ReaderPrefs`/`autoSummarize`（弃 localStorage）。**颜色模式**键待该功能落地再注册。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | ✅   | 用户 2026-06-03 指定             |
| **IPC 契约注册表重构（已交付，#8）**：契约 map `C`（`src/shared/ipc.ts`）为单一源——每通道一条 `def(channel,kind,input schema,output 类型载体)`；`bind(C.x,fn)` 产出纯数据 `Binding`、`register()` 唯一碰 `ipcMain`（绕开 `ELECTRON_RUN_AS_NODE` 下 `ipcMain` 为 undefined 的测试约束）；preload 改 `createApi(注入依赖)` 纯函数 + `invoker(C.x)`，类型由契约派生、零手写标注、`window.api` 形状不变（renderer 零改动）。output 用幽灵类型载体（不做运行时校验，与原 `handle` 一致）；判别联合返回的 handler（`providersListModels`/`aiSend`）加显式返回注解配合 `NoInfer<O>`。删旧 `handle` 与 `IPC` 常量对象。三道纯数据漂移测试兜底：契约完整性 / bindings 覆盖（==invoke 通道集）/ preload 覆盖（`conversations:create`·`get` 为 main-only 豁免）。spec/plan `2026-06-03-ipc-contract-registry*`。 | ✅   | #8（#7 架构债）                  |
| **renderer store 职责边界重构**：✅ `reader-store`（109 行/7 类职责）拆为 **navigation**（view/当前书章）/ **annotation**（选区/标注浮层/scrollCommand 命令信号）/ **chat**（会话/草稿/面板）三领域 store ＋ **prefs-store 吸收**落盘偏好（readerPrefs/lastHighlightStyle，hydrate 统一收口）；性质分层（事实投影/运行态/落盘偏好），openBook→chat 单向协调清会话，删死字段 sidebarOpen。纯 renderer、不动 main。spec/plan `2026-06-03-renderer-store-refactor*`。                                                                                                                                                                                                                                                                                                                                    | ✅   | #10（#7 架构债）                 |
| **DB lifecycle 债统一收口**：统一梳理数据生命周期与迁移策略，包括 FK cascade/删书清理、章节摘要状态派生化、message/run 状态模型（失败/重试/中断/usage 落库）、导入文件副本与删除清理、生产打包迁移路径。目标是把「事实」和「运行时状态」分清，避免孤儿行、半轮会话、崩溃残留状态和外部文件路径失效。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | ✅   | #9 P1–P4（#7 架构债）            |
| **真正导入 ePub + 简易文件管理机制**：主进程侧已落地（#9 P3b/P3c：导入复制 app 自有副本 `userData/books/<sha256(bookId)>.epub`、删书清理文件、缺失抛 `EpubFileMissingError`→重导；采 bookId 派生路径，未存 `sourcePath`）；删书 / relink UI 待 RA 轨。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | 🟡   | 主进程✅（用户 2026-06-03 指定） |
| **渲染层 UI 系统重构到 shadcn（Base UI 基底）**：分支 `refactor/shadcn-base-ui`（2026-06-03，spec `2026-06-03-shadcn-base-ui-refactor-design`）。`components.json`（`style: base-nova` = Base UI）+ shadcn CLI 导入 button/input/textarea/checkbox/dialog/popover/tabs/tooltip/card/label + `@base-ui/react` + `tw-animate-css`；token/`cn` 复用现有 index.css。消费方全接入：chrome 按钮、Sidebar→Tabs、NoteModal/SettingsPanel→Dialog、ReaderPrefs/SummaryPill→Popover、工具栏/Composer/AIPanel/标注图标→Button、顶栏 Tooltip。选区工具栏保留 RA3 iframe 逻辑（仅换内部按钮）。                                                                                                                                                                                                                     | ✅   | 用户 2026-06-03 指定             |
| **自绘窗口 chrome / 无系统 titlebar**：`titleBarStyle:"hidden"` + mac `trafficLightPosition`（红绿灯让位）+ 自定义 header（mac 加 `pl-20` 等）。要做完善跨平台方案：mac/win 控件差异、拖拽区 `-webkit-app-region: drag`、全屏态。用户试过的 WIP 已 `git stash`（`stash@{0}`）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | 🔴   | 用户 2026-06-03 WIP              |

### 接缝 / 小修

| 项                                                                                                                                                                                                                                                                                | 状态           | 来源                                      |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- | ----------------------------------------- |
| 跨章选区 → 独立会话 + best-effort 组合摘要（M-c 的 UI 侧）                                                                                                                                                                                                                        | 🔴             | ma4-deferred #8                           |
| `textOfParts` 历史回放丢弃 assistant 的 tool/reasoning part                                                                                                                                                                                                                       | 🟡 Phase1 有意 | ma4 #5 / ma5 #9                           |
| `conversations:create` FK 友好预检（现抛原始 SQLITE_CONSTRAINT）                                                                                                                                                                                                                  | 🔴 cosmetic    | ma4-deferred #7                           |
| 嵌套 TOC 层级目录渲染（现 `content.chapters` 扁平）                                                                                                                                                                                                                               | 🔴             | vslice p3                                 |
| 章内完整分页（`hasMore` 续读 `nextOffset`）                                                                                                                                                                                                                                       | 🔴             | vslice p3 / p4                            |
| 会话历史初值（重开会话载入 `messages.list-by-conversation`）                                                                                                                                                                                                                      | 🔴             | vslice p4                                 |
| 虚拟滚动高度稳定性（向上滚闪 + 图片 section 跳变）→ SectionFrame 就绪后上报稳定高度 + 测高缓存占位                                                                                                                                                                                | ✅             | 阅读精度 pass（2026-06-03）               |
| 当前章高亮滞后（overscan）→ VirtualDocs IntersectionObserver + topVisibleIndex 精确视口顶                                                                                                                                                                                         | ✅             | 阅读精度 pass（2026-06-03）               |
| 长书 `section.document` 常驻内存 → 距视口阈值外 unloadSection、重进重渲                                                                                                                                                                                                           | ✅             | 阅读精度 pass（2026-06-03）               |
| 全 schema 级 FK `ON DELETE CASCADE` 策略（6 个 book-owned FK 全加 `onDelete:cascade`；`assistants`/`providers` 共享资源不级联；表重建迁移）                                                                                                                                       | ✅             | #9 P3a                                    |
| **移除阅读区原生滚动条**：阅读区（Virtuoso 滚动容器）现显示 OS 滚动条；隐藏之（配合下条自绘条）。                                                                                                                                                                                 | 🔴             | 用户 2026-06-03 指定                      |
| **类 macOS 自绘滚动条**：迁移 ui-prototype 的 `ScrollArea.tsx`（自绘 thumb：height/top/opacity + 悬停淡入），统一用于阅读区/侧栏等滚动容器。                                                                                                                                      | 🔴             | 用户 2026-06-03 指定                      |
| **选区浮动工具栏迁 Base UI Popover**：`SelectionToolbar`/`HighlightStyleBar` 现保留 RA3 自定义 iframe 感知定位/消失逻辑（shadcn 重构期仅把内部按钮换成 Button 原语）；后续尝试迁到 Base UI Popover + virtual anchor 统一交互。                                                    | 🔴             | 用户 2026-06-03 指定（shadcn 重构期延后） |
| **ChipBar 迁 Base UI PreviewCard**：现为自定义 hover 卡片（hover + 计时桥 + 自绘向上定位）；Base UI Popover 点击式不匹配 hover，留待 PreviewCard 原语化。                                                                                                                         | 🔴             | shadcn 重构延后                           |
| **更广 Tooltip 应用 + Card 化 composite**：Tooltip 现仅阅读页顶栏 2 按钮，可推广到其余图标按钮；书卡/章节项/标注项/消息气泡等 composite 仍手搓 Tailwind，可按需抽成 shadcn `Card`。                                                                                               | 🔴             | shadcn 重构延后（按需）                   |
| **shadcn tabs 的 data-orientation 适配**：shadcn tabs 用 `data-horizontal`/`data-vertical`，Base UI `Tabs.Root` 发 `data-orientation`，属性名错配致方向类惰性。现 Sidebar 显式 `flex-col` + TabsList `h-8` 兜底（仅水平 tabs）；若再用 tabs 或加竖向，补 `@custom-variant` 映射。 | 🔴             | shadcn 重构发现                           |

| **chapters.summaryStatus 改派生态**：去 `summary_status` 列+CHECK（表重建迁移）、状态读时派生（内存 `inFlightChapters`/`failedChapters` 集 + `getChapterSummaryView`，镜像全书摘要）、删 `resetStuckSummaries`。契约 `{status,summary}` 不变 → IPC/renderer 零改动。 | ✅ | #9 P1（spec §2 / plan `…-p1-…`） |

### 已由竖切解决（存档，勿重复开）

M-a 流式 IPC · M-p 契约闭合 · `SendInput` Zod schema · `SendDeps`/`SummaryDeps` 生产工厂 · transport consume/cancel `callerStream` · `getChapterSummary` 补 `title` · chip 快照投影 · `presetId` 模板预填（解释/翻译/概括）· 工具章节 `id`/`href` 容错 · 摘要生成与发消息解耦（自动/手动触发）。

---

## 文档地图

- **`specs/`**：产品与技术设计——核心阅读闭环（Phase 1）、UP1 UI 原型、最小可用竖切。
- **`plans/`**：里程碑 bite-sized 实现计划——MA1–MA5、竖切 P1–P4、RA 轨任务分解。
- **记忆**（`~/.claude/.../memory/`）：`*-deferred-followups`（MA3/4/5 细节）、各类 feedback/project 记忆（见 `MEMORY.md` 索引）。
