# Renderer Store 职责边界重构设计（#10）

> 状态：设计已批准，待 writing-plans。
> 关联：#10（#7 架构债）；ROADMAP「renderer store 职责边界重构」。
> 日期：2026-06-03。

## 1. 背景与目标

`src/renderer/store/reader-store.ts`（109 行）是个「杂物抽屉」——单一 zustand store 里混了 **7 类性质不同**的状态：导航/当前书章、阅读偏好、选区、标注浮层、聊天草稿、侧栏、滚动命令。`settings-store` / `prefs-store`(autoSummarize) / `theme-store` 已先行独立，但 reader-store 仍是阅读器 UI 的全局袋。

**目标**：按**性质 + 领域**把 reader-store 拆开，让每个 store 单一职责、边界清楚。对齐 ROADMAP 原则——「main 管业务事实与副作用，renderer 管浏览器运行时行为与交互；运行时态可丢、可重建、可从 main 恢复」。

**性质分层**把当前混在一起的状态分成三种：

- **落盘偏好**（走 `persistPreference` + hydrate，主进程 preferences 表是源）：`prefs`、`lastHighlightStyle`。
- **可从 main 恢复的事实投影**（main 有权威源）：`currentBookId`/`currentChapterId`（progress 表）、`activeConversationId`（conversations 表）。
- **纯运行时 UI 态 / 命令信号**（可丢、不持久化）：`view`、`selection`、`styleBar`、`noteModal`、`draftText`、`draftChips`、`panelOpen`、`scrollToCfi`。

## 2. 非目标（YAGNI 边界）

- **不**实现「真·可从 main 恢复」：导航位置 / activeConversation 重启后从 main 自动恢复属独立 feature，不在本次范围。本次只把状态**标清性质**，不写恢复逻辑。
- **不**引入跨 store 的统一命令/信号抽象：当前命令信号只有 `scrollToCfi` 一个用户（AnnotationsList → EpubReader），保持现有 nonce 模式，YAGNI。
- **不**引入 zustand 中间件（persist/immer 等）或新依赖：沿用现有 `persistPreference` 显式落盘。
- **不**改动 main 侧、IPC 契约、preload：纯 renderer 内部重构。
- **不**改 UI 行为（除删除经核实的死字段 `sidebarOpen`，见 §6.4）。

## 3. 架构总览

reader-store 拆成 **3 个新建运行态领域 store** + 偏好**收口进既有 prefs-store**；`reader-store.ts` 删除。

| Store                      | 文件                        | 字段                                                              | 性质                                      |
| -------------------------- | --------------------------- | ----------------------------------------------------------------- | ----------------------------------------- |
| **navigation-store**（新） | `store/navigation-store.ts` | `view` · `currentBookId` · `currentChapterId`                     | view=运行态；book/chapter=事实投影        |
| **annotation-store**（新） | `store/annotation-store.ts` | `selection` · `styleBar` · `noteModal` · `scrollCommand`          | 全运行态 + 一个命令信号                   |
| **chat-store**（新）       | `store/chat-store.ts`       | `activeConversationId` · `draftText` · `draftChips` · `panelOpen` | activeConversationId=事实投影；其余运行态 |
| **prefs-store**（吸收）    | `store/prefs-store.ts`      | ＋`prefs` ＋`lastHighlightStyle`（已有 `autoSummarize`）          | 落盘偏好                                  |

被删字段：`sidebarOpen` / `setSidebarOpen`（死字段，见 §6.4）。

## 4. 各 Store 定义

### 4.1 navigation-store

```ts
interface NavigationState {
  view: "library" | "reader";
  currentBookId: string | null;
  currentChapterId: string | null;
}
interface NavigationActions {
  openBook: (bookId: string, chapterId?: string | null) => void;
  backToLibrary: () => void;
  setCurrentChapter: (chapterId: string) => void;
}
export const NAVIGATION_INITIAL: NavigationState = {
  view: "library",
  currentBookId: null,
  currentChapterId: null,
};
```

- `openBook` 设 `view:"reader"` + book/chapter，并**清空聊天会话**（见 §6.1 跨 store 协调）。
- `backToLibrary` 设 `view:"library"`。
- `setCurrentChapter(id)` 设 `currentChapterId`。

### 4.2 annotation-store

`AnnoTarget` / `StyleBarState` / `NoteModalState` 类型从 reader-store 迁来，连同其文档注释（NoteModalState.anchor 的快照说明）。

```ts
export type AnnoTarget = { type: "create" } | { type: "edit"; annotationId: string };
export interface StyleBarState {
  rect: { x: number; y: number; width: number; height: number };
  target: AnnoTarget;
}
export interface NoteModalState {
  target: AnnoTarget;
  anchor?: { cfiRange: string; selectedText: string };
}

interface AnnotationState {
  selection: SelectionInfo | null;
  styleBar: StyleBarState | null;
  noteModal: NoteModalState | null;
  /** 命令信号（非状态）：nonce 递增触发 EpubReader 滚动到该 CFI。 */
  scrollCommand: { cfi: string; nonce: number } | null;
}
interface AnnotationActions {
  setSelection: (selection: SelectionInfo | null) => void;
  openStyleBar: (s: StyleBarState) => void;
  closeStyleBar: () => void;
  openNoteModal: (s: NoteModalState) => void;
  closeNoteModal: () => void;
  requestScroll: (cfi: string) => void; // 原 requestScrollToCfi
}
export const ANNOTATION_INITIAL: AnnotationState = {
  selection: null,
  styleBar: null,
  noteModal: null,
  scrollCommand: null,
};
```

- `requestScroll(cfi)` 实现保持 nonce 递增：`set((s) => ({ scrollCommand: { cfi, nonce: (s.scrollCommand?.nonce ?? 0) + 1 } }))`。
- 命名变更：`scrollToCfi` → `scrollCommand`，`requestScrollToCfi` → `requestScroll`，注释标明「命令信号非状态」。

### 4.3 chat-store

```ts
interface ChatState {
  activeConversationId: string | null;
  draftText: string;
  draftChips: Chip[];
  panelOpen: boolean;
}
interface ChatActions {
  setActiveConversation: (id: string | null) => void;
  setDraftText: (text: string) => void;
  setDraftChips: (chips: Chip[]) => void;
  setPanelOpen: (open: boolean) => void;
}
export const CHAT_INITIAL: ChatState = {
  activeConversationId: null,
  draftText: "",
  draftChips: [],
  panelOpen: false,
};
```

### 4.4 prefs-store（吸收偏好）

在既有 `prefs-store`（`autoSummarize`）上新增 `prefs` 与 `lastHighlightStyle`，二者带落盘副作用：

```ts
interface PrefsState {
  autoSummarize: boolean; // 既有
  prefs: ReaderPrefs; // 新增（原 reader-store.prefs）
  lastHighlightStyle: AnnotationStyle; // 新增（原 reader-store.lastHighlightStyle）
}
interface PrefsActions {
  setAutoSummarize: (v: boolean) => void; // 既有
  updatePrefs: (patch: Partial<ReaderPrefs>) => void; // 新增，带 persistPreference("readerPrefs")
  setLastHighlightStyle: (style: AnnotationStyle) => void; // 新增，带 persistPreference("lastHighlightStyle")
}
```

初值（沿用原 reader-store）：`prefs: { fontScale: 1, lineHeight: 1.9, maxWidth: 640 }`，`lastHighlightStyle: "yellow"`。`updatePrefs` 合并 patch 后 `persistPreference({ key: "readerPrefs", value: prefs })`；`setLastHighlightStyle` 先 persist 再 set——逻辑原样搬运。

## 5. 关键设计决策

### 5.1 跨 store 协调（唯一写依赖）

原 `openBook` 顺手 `activeConversationId: null`（开新书清空上本会话）。拆分后导航与会话分属两 store。**决策**：`navigation.openBook` 内部调 `useChatStore.getState().setActiveConversation(null)`——单向依赖 navigation→chat，保住「开书即清会话」原子语义，不靠调用方记得协调。

```ts
openBook: (bookId, chapterId = null) => {
  set({ view: "reader", currentBookId: bookId, currentChapterId: chapterId });
  useChatStore.getState().setActiveConversation(null);
},
```

其余跨 store 访问全是**读**（组件外 `getState()`，见 §7），不构成耦合。

### 5.2 命令信号（scrollToCfi）

保持 nonce 命令模式（触发一次性副作用的正确手段），归 annotation-store，更名 `scrollCommand`/`requestScroll` 并注释。不抽跨 store 统一命令抽象（仅一个用户，YAGNI）。

### 5.3 persist / hydrate 迁移

- `updatePrefs` / `setLastHighlightStyle` 的 `persistPreference` 逻辑随字段移入 prefs-store。
- `hydrate-preferences.ts`：`readerPrefs` / `lastHighlightStyle` 改走 `usePrefsStore.setState(...)`（原走 `useReaderStore.setState`）。迁移后 hydrate **只碰 prefs-store**：

```ts
if (snap.readerPrefs) usePrefsStore.setState({ prefs: snap.readerPrefs });
if (snap.lastHighlightStyle)
  usePrefsStore.setState({ lastHighlightStyle: snap.lastHighlightStyle });
if (snap.autoSummarize !== undefined) usePrefsStore.setState({ autoSummarize: snap.autoSummarize });
```

### 5.4 sidebarOpen 死字段清理

`sidebarOpen` / `setSidebarOpen` 经核实**零消费方**：`Sidebar` 组件被 `ReaderView` 无条件渲染（`Sidebar.tsx:8` / `ReaderView.tsx:99`），从不读 sidebarOpen。删除该字段与 action（YAGNI；将来要做侧栏折叠再加）。

### 5.5 lastHighlightStyle 归属

`lastHighlightStyle` 虽被标注交互簇（SelectionToolbar/NoteModal/HighlightStyleBar）消费，但性质是**落盘偏好**（走 persist + hydrate），故按性质归 prefs-store。标注组件从 prefs-store 读它、从 annotation-store 读浮层态——性质分层优先于就近内聚。

## 6. 消费方迁移映射

机械替换 `useReaderStore((s) => s.X)` → 对应新 store。完整映射（字段 → store）：

| 消费方                                     | 字段                                                                      | → Store    |
| ------------------------------------------ | ------------------------------------------------------------------------- | ---------- |
| `App.tsx`                                  | view                                                                      | navigation |
| `reader/ChapterList.tsx`                   | currentChapterId, setCurrentChapter                                       | navigation |
| `reader/ReaderView.tsx`                    | currentBookId, currentChapterId, backToLibrary                            | navigation |
| `reader/ReaderView.tsx`                    | panelOpen, setPanelOpen                                                   | chat       |
| `reader/EpubReader.tsx`                    | currentChapterId, setCurrentChapter                                       | navigation |
| `reader/EpubReader.tsx`                    | prefs                                                                     | prefs      |
| `reader/EpubReader.tsx`                    | setSelection, openStyleBar, closeStyleBar, scrollToCfi→scrollCommand      | annotation |
| `reader/SelectionToolbar.tsx`              | selection, setSelection, openStyleBar, openNoteModal, styleBar, noteModal | annotation |
| `reader/SelectionToolbar.tsx`              | currentBookId                                                             | navigation |
| `reader/SelectionToolbar.tsx`              | lastHighlightStyle                                                        | prefs      |
| `reader/NoteModal.tsx`                     | noteModal, closeNoteModal, setSelection                                   | annotation |
| `reader/NoteModal.tsx`                     | currentBookId                                                             | navigation |
| `reader/NoteModal.tsx`                     | lastHighlightStyle                                                        | prefs      |
| `reader/HighlightStyleBar.tsx`             | styleBar, closeStyleBar, openNoteModal, setSelection                      | annotation |
| `reader/HighlightStyleBar.tsx`             | setLastHighlightStyle                                                     | prefs      |
| `reader/HighlightStyleBar.tsx`             | currentBookId                                                             | navigation |
| `reader/AnnotationsList.tsx`               | requestScrollToCfi→requestScroll                                          | annotation |
| `reader/ReaderPrefs.tsx`                   | prefs, updatePrefs                                                        | prefs      |
| `library/LibraryView.tsx`                  | openBook                                                                  | navigation |
| `ai/AIPanel.tsx`                           | setActiveConversation, setPanelOpen                                       | chat       |
| `ai/Composer.tsx`                          | draftText, draftChips, setDraftText, setDraftChips, panelOpen             | chat       |
| `ai/SummaryPill.tsx`                       | currentBookId, currentChapterId                                           | navigation |
| `ai/SummaryPill.tsx`                       | panelOpen                                                                 | chat       |
| `ai/use-ai-actions.ts`（getState）         | selection, setSelection                                                   | annotation |
| `ai/use-ai-actions.ts`（getState）         | setDraftChips, setDraftText, setPanelOpen                                 | chat       |
| `ai/ipc-chat-transport.ts`（getState）     | currentBookId, currentChapterId                                           | navigation |
| `ai/ipc-chat-transport.ts`（getState）     | activeConversationId, setActiveConversation                               | chat       |
| `store/hydrate-preferences.ts`（setState） | prefs, lastHighlightStyle                                                 | prefs      |

注：`use-ai-actions.ts` 与 `ipc-chat-transport.ts` 的单次 `useReaderStore.getState()` 解构需拆成对应两个 store 的 `getState()`（各取所需字段）。

## 7. 测试策略

- 删 `reader-store.test.ts`，按字段拆成：
  - `navigation-store.test.ts`：`openBook` 切换 view/ids、`openBook` 仅 bookId 时 chapter 为 null、`backToLibrary` 重置 view。
  - `chat-store.test.ts`：`setActiveConversation` 存 id。
  - `prefs-store.test.ts`：`updatePrefs` 合并（fontScale 改、maxWidth 保留默认）。
- **新增协调测试**（navigation-store.test.ts）：`openBook` 后 `useChatStore.getState().activeConversationId === null`（验证 §5.1 跨 store 清会话）。每个 test 用各自的 `*_INITIAL` 在 `beforeEach` 重置。

## 8. 验证与风险

- 纯 renderer 重构，无 main 改动；React Compiler 已启用——不手写 `useCallback`/`useMemo`。
- 每个组件迁移后保持 selector 粒度（逐字段 `useStore((s) => s.x)`），不退化为整 store 订阅。
- 验证门禁：`pnpm typecheck` + `pnpm test` 全绿。
- 手动冒烟路径：开书/回书库、切章、选区→工具栏、高亮/笔记浮层、AI 面板草稿、偏好调节、AnnotationsList 跳转滚动——逐项行为与重构前一致。
- 风险低：字段→store 一一映射、行为零变化（除删死字段）；唯一新增行为是 §5.1 的显式协调（原本就发生在 openBook 内，只是换了落点）。
