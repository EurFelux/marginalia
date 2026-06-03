# Renderer Store 职责边界重构 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `src/renderer/store/reader-store.ts`（109 行 / 7 类职责）按性质+领域拆成 navigation / annotation / chat 三个领域 store，并把落盘偏好（`prefs`/`lastHighlightStyle`）收口进既有 `prefs-store`，行为零变化（除删死字段 `sidebarOpen` 与 openBook 协调显式化）。

**Architecture:** 按 store 原子迁移、`reader-store` 渐进瘦身——每个 Task 建一个新 store（先写单元测试）、把该领域全部消费方从 `useReaderStore` 切到新 store、从 `reader-store` 删走已迁字段，每步 `pnpm typecheck` + `pnpm test` 全绿。顺序：先 chat-store（`navigation.openBook` 需调它清会话）→ navigation → annotation → prefs 吸收并删空 reader-store。纯 renderer 重构，不动 main / IPC / preload。

**Tech Stack:** zustand v5（`create`，selector 逐字段订阅）、vitest 4（跑在 Electron ABI，`pnpm test`）、React 19 + React Compiler（**不手写** `useCallback`/`useMemo`）、`persistPreference` 显式落盘。

**已核事实：**

- `reader-store.ts` 当前字段：`view` `currentBookId` `currentChapterId` `selection` `prefs` `activeConversationId` `panelOpen` `sidebarOpen` `draftChips` `draftText` `styleBar` `noteModal` `scrollToCfi` `lastHighlightStyle`，外加 `AnnoTarget`/`StyleBarState`/`NoteModalState` 类型与 `READER_INITIAL`。
- `sidebarOpen`/`setSidebarOpen` **零消费方**（`Sidebar` 被 `ReaderView` 无条件渲染）——删除。
- 消费方→store 完整映射见 spec §6（`docs/superpowers/specs/2026-06-03-renderer-store-refactor-design.md`）。
- zustand v5 测试重置惯例（沿用现 `reader-store.test.ts`）：`beforeEach(() => useXStore.setState(X_INITIAL))`（合并式，不覆盖 actions）。
- `persistPreference` 签名：`persistPreference({ key, value })`（见 `store/persist-preference.ts`，现被 reader-store/prefs-store 使用）。

---

## File Structure

| 文件                                                | 责任                                       | Task           |
| --------------------------------------------------- | ------------------------------------------ | -------------- |
| `src/renderer/store/chat-store.ts`（新）            | AI 面板会话/草稿运行态                     | 1              |
| `src/renderer/store/chat-store.test.ts`（新）       | chat-store 单测                            | 1              |
| `src/renderer/store/navigation-store.ts`（新）      | 视图/当前书章导航 + openBook 清会话协调    | 2              |
| `src/renderer/store/navigation-store.test.ts`（新） | navigation-store 单测（含协调测试）        | 2              |
| `src/renderer/store/annotation-store.ts`（新）      | 选区/标注浮层/滚动命令 + 浮层类型          | 3              |
| `src/renderer/store/annotation-store.test.ts`（新） | annotation-store 单测                      | 3              |
| `src/renderer/store/prefs-store.ts`（改）           | 吸收 `prefs`/`lastHighlightStyle` 落盘偏好 | 4              |
| `src/renderer/store/prefs-store.test.ts`（新）      | prefs-store 单测                           | 4              |
| `src/renderer/store/hydrate-preferences.ts`（改）   | prefs/lastHighlightStyle 改走 prefs-store  | 4              |
| `src/renderer/store/reader-store.ts`（删）          | 字段迁完后删除                             | 1–4 渐进，4 删 |
| `src/renderer/store/reader-store.test.ts`（删）     | 用例迁完后删除                             | 1–4 渐进，4 删 |
| 各消费方组件/模块（改）                             | selector 切到新 store                      | 1–4            |

---

## Task 1: chat-store（会话/草稿）

**Files:**

- Create: `src/renderer/store/chat-store.ts`
- Create: `src/renderer/store/chat-store.test.ts`
- Modify: `src/renderer/store/reader-store.ts`（删 chat 字段；openBook 改调 chat 清会话）
- Modify: `src/renderer/store/reader-store.test.ts`（删 setActiveConversation 用例）
- Modify 消费方：`reader/ReaderView.tsx`、`ai/AIPanel.tsx`、`ai/Composer.tsx`、`ai/SummaryPill.tsx`、`ai/use-ai-actions.ts`、`ai/ipc-chat-transport.ts`

- [ ] **Step 1: 写 chat-store 失败测试**

Create `src/renderer/store/chat-store.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useChatStore, CHAT_INITIAL } from "@renderer/store/chat-store";

beforeEach(() => useChatStore.setState(CHAT_INITIAL));

describe("chat-store", () => {
  it("setActiveConversation stores id", () => {
    useChatStore.getState().setActiveConversation("conv1");
    expect(useChatStore.getState().activeConversationId).toBe("conv1");
  });
  it("setDraftText / setDraftChips update drafts", () => {
    useChatStore.getState().setDraftText("hi");
    useChatStore.getState().setDraftChips([{ id: "c1" } as never]);
    expect(useChatStore.getState().draftText).toBe("hi");
    expect(useChatStore.getState().draftChips).toHaveLength(1);
  });
  it("setPanelOpen toggles", () => {
    useChatStore.getState().setPanelOpen(true);
    expect(useChatStore.getState().panelOpen).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/store/chat-store.test.ts`
Expected: FAIL（`Cannot find module '@renderer/store/chat-store'`）

- [ ] **Step 3: 建 chat-store 实现**

Create `src/renderer/store/chat-store.ts`：

```ts
import { create } from "zustand";
import type { Chip } from "@shared/chat";

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

export const useChatStore = create<ChatState & ChatActions>((set) => ({
  ...CHAT_INITIAL,
  setActiveConversation: (activeConversationId) => set({ activeConversationId }),
  setDraftText: (draftText) => set({ draftText }),
  setDraftChips: (draftChips) => set({ draftChips }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
}));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/store/chat-store.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 切 chat 消费方到 useChatStore**

每个文件保留对其它仍在 reader-store 字段的 `useReaderStore` 用法，仅把 chat 字段切走（必要时新增 `import { useChatStore } from "@renderer/store/chat-store";`）。

`reader/ReaderView.tsx`（行 25–26）——`panelOpen`/`setPanelOpen` 切 chat：

```ts
const panelOpen = useChatStore((s) => s.panelOpen);
const setPanelOpen = useChatStore((s) => s.setPanelOpen);
```

`ai/AIPanel.tsx`（行 19–20）——整文件仅用 chat 字段，import 从 `useReaderStore` 换成 `useChatStore`：

```ts
const setActiveConversation = useChatStore((s) => s.setActiveConversation);
const setPanelOpen = useChatStore((s) => s.setPanelOpen);
```

`ai/Composer.tsx`（行 18–22）——整文件仅用 chat 字段，import 换 `useChatStore`：

```ts
const draftText = useChatStore((s) => s.draftText);
const draftChips = useChatStore((s) => s.draftChips);
const setDraftText = useChatStore((s) => s.setDraftText);
const setDraftChips = useChatStore((s) => s.setDraftChips);
const panelOpen = useChatStore((s) => s.panelOpen);
```

`ai/SummaryPill.tsx`（行 18）——`panelOpen` 切 chat（`currentBookId`/`currentChapterId` 仍用 `useReaderStore`，Task 2 再迁）：

```ts
const panelOpen = useChatStore((s) => s.panelOpen);
```

保留该文件顶部 `import { useReaderStore } ...` 并新增 `import { useChatStore } from "@renderer/store/chat-store";`。

`ai/use-ai-actions.ts`（行 21–22）——把 chat 相关 setter 改从 chat-store 取（`selection`/`setSelection` 仍 reader-store，Task 3 再迁）：

```ts
const { selection, setSelection } = useReaderStore.getState();
const { setDraftChips, setDraftText, setPanelOpen } = useChatStore.getState();
```

文件顶部新增 `import { useChatStore } from "@renderer/store/chat-store";`。

`ai/ipc-chat-transport.ts`：

- 行 58 解构拆开（`currentBookId`/`currentChapterId` 仍 reader-store，Task 2 迁）：

```ts
const { currentBookId, currentChapterId } = useReaderStore.getState();
const { activeConversationId } = useChatStore.getState();
```

- 行 83 回写改 chat-store：

```ts
useChatStore.getState().setActiveConversation(ack.conversationId); // ack 回写（组件外）
```

- 文件顶部新增 `import { useChatStore } from "@renderer/store/chat-store";`。

- [ ] **Step 6: 从 reader-store 删 chat 字段，openBook 改调 chat 清会话**

`src/renderer/store/reader-store.ts`：

- `ReaderState` 删 `activeConversationId` `panelOpen` `draftChips` `draftText`。
- `ReaderActions` 删 `setActiveConversation` `setPanelOpen` `setDraftText` `setDraftChips`。
- `READER_INITIAL` 删对应初值。
- store 实现删对应 action 实现。
- `openBook` 的 `activeConversationId: null` 移除，改为调用 chat-store（保持「开书清会话」语义）：

```ts
  openBook: (bookId, chapterId = null) => {
    set({ view: "reader", currentBookId: bookId, currentChapterId: chapterId });
    useChatStore.getState().setActiveConversation(null);
  },
```

- 文件顶部新增 `import { useChatStore } from "@renderer/store/chat-store";`。
- `import type { Chip } from "@shared/chat";` 现已无用 → 删。

`src/renderer/store/reader-store.test.ts`：删 `setActiveConversation stores id` 用例（行 20–23）。

- [ ] **Step 7: typecheck + 全量测试**

Run: `pnpm typecheck`
Expected: 无错误。

Run: `pnpm test`
Expected: PASS（chat-store 新测试通过；reader-store 残余用例 openBook/backToLibrary/updatePrefs 仍通过）。

- [ ] **Step 8: Commit**

```bash
git add src/renderer/store/chat-store.ts src/renderer/store/chat-store.test.ts \
  src/renderer/store/reader-store.ts src/renderer/store/reader-store.test.ts \
  src/renderer/reader/ReaderView.tsx src/renderer/ai/AIPanel.tsx \
  src/renderer/ai/Composer.tsx src/renderer/ai/SummaryPill.tsx \
  src/renderer/ai/use-ai-actions.ts src/renderer/ai/ipc-chat-transport.ts
git commit -m "refactor(store): extract chat-store from reader-store (#10)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: navigation-store（视图/当前书章）

**Files:**

- Create: `src/renderer/store/navigation-store.ts`
- Create: `src/renderer/store/navigation-store.test.ts`
- Modify: `src/renderer/store/reader-store.ts`（删 view/book/chapter 字段与 openBook/backToLibrary/setCurrentChapter）
- Modify: `src/renderer/store/reader-store.test.ts`（删 openBook/backToLibrary 用例）
- Modify 消费方：`App.tsx`、`reader/ChapterList.tsx`、`reader/ReaderView.tsx`、`reader/EpubReader.tsx`、`library/LibraryView.tsx`、`ai/SummaryPill.tsx`、`reader/SelectionToolbar.tsx`、`reader/NoteModal.tsx`、`reader/HighlightStyleBar.tsx`、`ai/ipc-chat-transport.ts`

- [ ] **Step 1: 写 navigation-store 失败测试**

Create `src/renderer/store/navigation-store.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useNavigationStore, NAVIGATION_INITIAL } from "@renderer/store/navigation-store";
import { useChatStore, CHAT_INITIAL } from "@renderer/store/chat-store";

beforeEach(() => {
  useNavigationStore.setState(NAVIGATION_INITIAL);
  useChatStore.setState(CHAT_INITIAL);
});

describe("navigation-store", () => {
  it("openBook switches to reader view with ids", () => {
    useNavigationStore.getState().openBook("b1", "c1");
    const s = useNavigationStore.getState();
    expect(s.view).toBe("reader");
    expect(s.currentBookId).toBe("b1");
    expect(s.currentChapterId).toBe("c1");
  });
  it("openBook with only bookId leaves currentChapterId null", () => {
    useNavigationStore.getState().openBook("b1");
    expect(useNavigationStore.getState().currentChapterId).toBeNull();
  });
  it("backToLibrary resets view", () => {
    useNavigationStore.getState().openBook("b1", "c1");
    useNavigationStore.getState().backToLibrary();
    expect(useNavigationStore.getState().view).toBe("library");
  });
  it("openBook clears active conversation (cross-store coordination)", () => {
    useChatStore.getState().setActiveConversation("conv1");
    useNavigationStore.getState().openBook("b2");
    expect(useChatStore.getState().activeConversationId).toBeNull();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/store/navigation-store.test.ts`
Expected: FAIL（`Cannot find module '@renderer/store/navigation-store'`）

- [ ] **Step 3: 建 navigation-store 实现**

Create `src/renderer/store/navigation-store.ts`：

```ts
import { create } from "zustand";
import { useChatStore } from "@renderer/store/chat-store";

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

export const useNavigationStore = create<NavigationState & NavigationActions>((set) => ({
  ...NAVIGATION_INITIAL,
  openBook: (bookId, chapterId = null) => {
    set({ view: "reader", currentBookId: bookId, currentChapterId: chapterId });
    useChatStore.getState().setActiveConversation(null); // 开书清上本会话（跨 store 协调）
  },
  backToLibrary: () => set({ view: "library" }),
  setCurrentChapter: (currentChapterId) => set({ currentChapterId }),
}));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/store/navigation-store.test.ts`
Expected: PASS（4 个用例，含跨 store 协调）

- [ ] **Step 5: 切 navigation 消费方到 useNavigationStore**

`App.tsx`（行 12）——整文件仅用 `view`，import 换 `useNavigationStore`：

```ts
const view = useNavigationStore((s) => s.view);
```

`reader/ChapterList.tsx`（行 9–10）——import 换 `useNavigationStore`：

```ts
const currentChapterId = useNavigationStore((s) => s.currentChapterId);
const setCurrentChapter = useNavigationStore((s) => s.setCurrentChapter);
```

`reader/ReaderView.tsx`（行 22–24）——`currentBookId`/`currentChapterId`/`backToLibrary` 切 navigation（`panelOpen` 已在 Task 1 用 chat）：

```ts
const bookId = useNavigationStore((s) => s.currentBookId);
const chapterId = useNavigationStore((s) => s.currentChapterId);
const backToLibrary = useNavigationStore((s) => s.backToLibrary);
```

顶部新增 `import { useNavigationStore } from "@renderer/store/navigation-store";`。

`reader/EpubReader.tsx`（行 35–36）——`currentChapterId`/`setCurrentChapter` 切 navigation（`prefs`/选区/滚动等 Task 3/4 再迁）：

```ts
const currentChapterId = useNavigationStore((s) => s.currentChapterId);
const setCurrentChapter = useNavigationStore((s) => s.setCurrentChapter);
```

顶部新增 `import { useNavigationStore } from "@renderer/store/navigation-store";`。

`library/LibraryView.tsx`（行 22）——import 换 `useNavigationStore`：

```ts
const openBook = useNavigationStore((s) => s.openBook);
```

`ai/SummaryPill.tsx`（行 16–17）——`currentBookId`/`currentChapterId` 切 navigation（`panelOpen` 已 chat）：

```ts
const bookId = useNavigationStore((s) => s.currentBookId);
const chapterId = useNavigationStore((s) => s.currentChapterId);
```

顶部新增 `import { useNavigationStore } ...`；该文件不再用 reader-store（仅 chat + navigation），删 `import { useReaderStore } ...`。

`reader/SelectionToolbar.tsx`（行 25）——`currentBookId` 切 navigation（选区/浮层/lastStyle 后续迁）：

```ts
const bookId = useNavigationStore((s) => s.currentBookId);
```

顶部新增 `import { useNavigationStore } ...`。

`reader/NoteModal.tsx`（行 25）——`currentBookId` 切 navigation：

```ts
const bookId = useNavigationStore((s) => s.currentBookId);
```

顶部新增 `import { useNavigationStore } ...`。

`reader/HighlightStyleBar.tsx`（行 20）——`currentBookId` 切 navigation：

```ts
const bookId = useNavigationStore((s) => s.currentBookId);
```

顶部新增 `import { useNavigationStore } ...`。

`ai/ipc-chat-transport.ts`（行 58）——`currentBookId`/`currentChapterId` 切 navigation：

```ts
const { currentBookId, currentChapterId } = useNavigationStore.getState();
const { activeConversationId } = useChatStore.getState();
```

顶部新增 `import { useNavigationStore } from "@renderer/store/navigation-store";`。

- [ ] **Step 6: 从 reader-store 删 navigation 字段**

`src/renderer/store/reader-store.ts`：

- `ReaderState` 删 `view` `currentBookId` `currentChapterId`。
- `ReaderActions` 删 `openBook` `backToLibrary` `setCurrentChapter`。
- `READER_INITIAL` 删对应初值。
- store 实现删 `openBook`/`backToLibrary`/`setCurrentChapter`，并删 Task 1 加的 `import { useChatStore } ...`（openBook 已迁走，reader-store 不再引用 chat）。

`src/renderer/store/reader-store.test.ts`：删 `openBook switches...`、`backToLibrary resets view`、`openBook with only bookId...` 三个用例（剩 `updatePrefs merges`）。

- [ ] **Step 7: typecheck + 全量测试**

Run: `pnpm typecheck`
Expected: 无错误。

Run: `pnpm test`
Expected: PASS（navigation-store 测试通过；reader-store 残余仅 updatePrefs）。

- [ ] **Step 8: Commit**

```bash
git add src/renderer/store/navigation-store.ts src/renderer/store/navigation-store.test.ts \
  src/renderer/store/reader-store.ts src/renderer/store/reader-store.test.ts \
  src/renderer/App.tsx src/renderer/reader/ChapterList.tsx src/renderer/reader/ReaderView.tsx \
  src/renderer/reader/EpubReader.tsx src/renderer/library/LibraryView.tsx \
  src/renderer/ai/SummaryPill.tsx src/renderer/reader/SelectionToolbar.tsx \
  src/renderer/reader/NoteModal.tsx src/renderer/reader/HighlightStyleBar.tsx \
  src/renderer/ai/ipc-chat-transport.ts
git commit -m "refactor(store): extract navigation-store from reader-store (#10)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: annotation-store（选区/标注浮层/滚动命令）

**Files:**

- Create: `src/renderer/store/annotation-store.ts`
- Create: `src/renderer/store/annotation-store.test.ts`
- Modify: `src/renderer/store/reader-store.ts`（删 selection/styleBar/noteModal/scrollToCfi 与浮层类型）
- Modify 消费方：`reader/SelectionToolbar.tsx`、`reader/EpubReader.tsx`、`reader/NoteModal.tsx`、`reader/HighlightStyleBar.tsx`、`reader/AnnotationsList.tsx`、`ai/use-ai-actions.ts`

- [ ] **Step 1: 写 annotation-store 失败测试**

Create `src/renderer/store/annotation-store.test.ts`：

```ts
import { beforeEach, describe, expect, it } from "vitest";
import { useAnnotationStore, ANNOTATION_INITIAL } from "@renderer/store/annotation-store";

beforeEach(() => useAnnotationStore.setState(ANNOTATION_INITIAL));

describe("annotation-store", () => {
  it("setSelection stores selection", () => {
    useAnnotationStore.getState().setSelection({ selectionText: "x" } as never);
    expect(useAnnotationStore.getState().selection).not.toBeNull();
  });
  it("openStyleBar / closeStyleBar toggle", () => {
    useAnnotationStore.getState().openStyleBar({
      rect: { x: 0, y: 0, width: 0, height: 0 },
      target: { type: "create" },
    });
    expect(useAnnotationStore.getState().styleBar).not.toBeNull();
    useAnnotationStore.getState().closeStyleBar();
    expect(useAnnotationStore.getState().styleBar).toBeNull();
  });
  it("requestScroll bumps nonce each call", () => {
    useAnnotationStore.getState().requestScroll("cfi-a");
    const n1 = useAnnotationStore.getState().scrollCommand?.nonce;
    useAnnotationStore.getState().requestScroll("cfi-b");
    const cmd = useAnnotationStore.getState().scrollCommand;
    expect(cmd?.cfi).toBe("cfi-b");
    expect(cmd?.nonce).toBe((n1 ?? 0) + 1);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/store/annotation-store.test.ts`
Expected: FAIL（`Cannot find module '@renderer/store/annotation-store'`）

- [ ] **Step 3: 建 annotation-store 实现**

Create `src/renderer/store/annotation-store.ts`（浮层类型从 reader-store 迁来，连同 NoteModalState.anchor 的快照注释）：

```ts
import { create } from "zustand";
import type { SelectionInfo } from "@renderer/types";

export type AnnoTarget = { type: "create" } | { type: "edit"; annotationId: string };
export interface StyleBarState {
  rect: { x: number; y: number; width: number; height: number };
  target: AnnoTarget;
}
export interface NoteModalState {
  target: AnnoTarget;
  /**
   * create 模式的选区快照（cfiRange/selectedText）；edit 模式不需要（读标注）。
   * 快照避免 save 时依赖易失的 `selection`——笔记过长时 textarea 内部滚动会被
   * EpubReader 的捕获阶段 scroll 监听清掉选区，若 save 仍读 selection 会静默丢笔记。
   */
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
  requestScroll: (cfi: string) => void;
}

export const ANNOTATION_INITIAL: AnnotationState = {
  selection: null,
  styleBar: null,
  noteModal: null,
  scrollCommand: null,
};

export const useAnnotationStore = create<AnnotationState & AnnotationActions>((set) => ({
  ...ANNOTATION_INITIAL,
  setSelection: (selection) => set({ selection }),
  openStyleBar: (styleBar) => set({ styleBar }),
  closeStyleBar: () => set({ styleBar: null }),
  openNoteModal: (noteModal) => set({ noteModal }),
  closeNoteModal: () => set({ noteModal: null }),
  requestScroll: (cfi) =>
    set((s) => ({ scrollCommand: { cfi, nonce: (s.scrollCommand?.nonce ?? 0) + 1 } })),
}));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/store/annotation-store.test.ts`
Expected: PASS（3 个用例）

- [ ] **Step 5: 切 annotation 消费方到 useAnnotationStore**

类型 import 也从 annotation-store 取（替代原 `from "@renderer/store/reader-store"`）。

`reader/SelectionToolbar.tsx`（行 19–24）——`selection`/`openStyleBar`/`openNoteModal`/`setSelection`/`styleBar`/`noteModal` 切 annotation：

```ts
const selection = useAnnotationStore((s) => s.selection);
const openStyleBar = useAnnotationStore((s) => s.openStyleBar);
const openNoteModal = useAnnotationStore((s) => s.openNoteModal);
const setSelection = useAnnotationStore((s) => s.setSelection);
const styleBar = useAnnotationStore((s) => s.styleBar);
const noteModal = useAnnotationStore((s) => s.noteModal);
```

顶部新增 `import { useAnnotationStore } from "@renderer/store/annotation-store";`；若该文件从 reader-store import 过 `StyleBarState`/`NoteModalState`/`AnnoTarget`，改成 from annotation-store。

`reader/EpubReader.tsx`（行 38–41）——`setSelection`/`openStyleBar`/`closeStyleBar` 切 annotation，`scrollToCfi`→`scrollCommand`：

```ts
const setSelection = useAnnotationStore((s) => s.setSelection);
const openStyleBar = useAnnotationStore((s) => s.openStyleBar);
const closeStyleBar = useAnnotationStore((s) => s.closeStyleBar);
const scrollCommand = useAnnotationStore((s) => s.scrollCommand);
```

把文件内原引用 `scrollToCfi`（如 effect 依赖、`scrollToCfi?.cfi`/`scrollToCfi?.nonce`）改名为 `scrollCommand`。顶部新增 `import { useAnnotationStore } ...`。

`reader/NoteModal.tsx`（行 21–23）——`noteModal`/`closeNoteModal`/`setSelection` 切 annotation：

```ts
const noteModal = useAnnotationStore((s) => s.noteModal);
const closeNoteModal = useAnnotationStore((s) => s.closeNoteModal);
const setSelection = useAnnotationStore((s) => s.setSelection);
```

顶部新增 `import { useAnnotationStore } ...`；浮层类型 import 改 from annotation-store。

`reader/HighlightStyleBar.tsx`（行 15–18）——`styleBar`/`closeStyleBar`/`openNoteModal`/`setSelection` 切 annotation：

```ts
const styleBar = useAnnotationStore((s) => s.styleBar);
const closeStyleBar = useAnnotationStore((s) => s.closeStyleBar);
const openNoteModal = useAnnotationStore((s) => s.openNoteModal);
const setSelection = useAnnotationStore((s) => s.setSelection);
```

顶部新增 `import { useAnnotationStore } ...`；浮层类型 import 改 from annotation-store。

`reader/AnnotationsList.tsx`（行 24）——`requestScrollToCfi`→`requestScroll`：

```ts
const requestScroll = useAnnotationStore((s) => s.requestScroll);
```

把文件内调用处 `requestScrollToCfi(...)` 改为 `requestScroll(...)`。import 从 `useReaderStore` 换 `useAnnotationStore`。

`ai/use-ai-actions.ts`（行 21）——`selection`/`setSelection` 切 annotation：

```ts
const { selection, setSelection } = useAnnotationStore.getState();
const { setDraftChips, setDraftText, setPanelOpen } = useChatStore.getState();
```

顶部把 `import { useReaderStore } ...` 换成 `import { useAnnotationStore } from "@renderer/store/annotation-store";`（该文件不再用 reader-store）。

- [ ] **Step 6: 从 reader-store 删 annotation 字段与类型**

`src/renderer/store/reader-store.ts`：

- 删 `AnnoTarget`/`StyleBarState`/`NoteModalState` 类型定义（已迁 annotation-store）。
- `ReaderState` 删 `selection` `styleBar` `noteModal` `scrollToCfi`。
- `ReaderActions` 删 `setSelection` `openStyleBar` `closeStyleBar` `openNoteModal` `closeNoteModal` `requestScrollToCfi`。
- `READER_INITIAL` 与 store 实现删对应项。
- 删已无用的 `import type { SelectionInfo } from "@renderer/types";`（若 prefs 仍用其他 types import 则保留相应部分）。

此时 reader-store 仅剩 `prefs` / `lastHighlightStyle` / `sidebarOpen` 三字段及其 actions。

- [ ] **Step 7: typecheck + 全量测试**

Run: `pnpm typecheck`
Expected: 无错误。

Run: `pnpm test`
Expected: PASS（annotation-store 测试通过；reader-store 残余仅 updatePrefs 用例）。

- [ ] **Step 8: Commit**

```bash
git add src/renderer/store/annotation-store.ts src/renderer/store/annotation-store.test.ts \
  src/renderer/store/reader-store.ts \
  src/renderer/reader/SelectionToolbar.tsx src/renderer/reader/EpubReader.tsx \
  src/renderer/reader/NoteModal.tsx src/renderer/reader/HighlightStyleBar.tsx \
  src/renderer/reader/AnnotationsList.tsx src/renderer/ai/use-ai-actions.ts
git commit -m "refactor(store): extract annotation-store from reader-store (#10)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: prefs-store 吸收偏好 + 删空 reader-store

**Files:**

- Modify: `src/renderer/store/prefs-store.ts`（加 prefs/lastHighlightStyle）
- Create: `src/renderer/store/prefs-store.test.ts`
- Modify: `src/renderer/store/hydrate-preferences.ts`（prefs/lastHighlightStyle 改走 prefs-store）
- Modify 消费方：`reader/ReaderPrefs.tsx`、`reader/EpubReader.tsx`、`reader/SelectionToolbar.tsx`、`reader/NoteModal.tsx`、`reader/HighlightStyleBar.tsx`
- Delete: `src/renderer/store/reader-store.ts`、`src/renderer/store/reader-store.test.ts`

- [ ] **Step 1: 写 prefs-store 失败测试**

Create `src/renderer/store/prefs-store.test.ts`：

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@renderer/store/persist-preference", () => ({ persistPreference: vi.fn() }));

import { usePrefsStore } from "@renderer/store/prefs-store";

const INITIAL = usePrefsStore.getState();
beforeEach(() => usePrefsStore.setState(INITIAL));

describe("prefs-store", () => {
  it("updatePrefs merges patch, keeps other fields", () => {
    usePrefsStore.getState().updatePrefs({ fontScale: 1.2 });
    expect(usePrefsStore.getState().prefs.fontScale).toBe(1.2);
    expect(usePrefsStore.getState().prefs.maxWidth).toBe(640);
  });
  it("setLastHighlightStyle updates style", () => {
    usePrefsStore.getState().setLastHighlightStyle("blue");
    expect(usePrefsStore.getState().lastHighlightStyle).toBe("blue");
  });
});
```

> `persist-preference` 被 mock，避免单测触达 `window.api`（headless 无 preload）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/store/prefs-store.test.ts`
Expected: FAIL（`updatePrefs`/`prefs` 未定义在 prefs-store）

- [ ] **Step 3: prefs-store 加 prefs/lastHighlightStyle**

修改 `src/renderer/store/prefs-store.ts` 为：

```ts
import { create } from "zustand";
import type { AnnotationStyle } from "@shared/annotations";
import type { ReaderPrefs } from "@renderer/types";
import { persistPreference } from "@renderer/store/persist-preference";

interface PrefsState {
  /** 开章时自动生成本章摘要（默认关——控成本；landing/onboarding 时引导用户开启）。 */
  autoSummarize: boolean;
  /** 阅读排版偏好（字号/行高/版心宽）。 */
  prefs: ReaderPrefs;
  /** 上次选用的高亮样式；选「高亮标记」时直接套用（Apple Books 式记忆）。 */
  lastHighlightStyle: AnnotationStyle;
}
interface PrefsActions {
  setAutoSummarize: (v: boolean) => void;
  updatePrefs: (patch: Partial<ReaderPrefs>) => void;
  setLastHighlightStyle: (style: AnnotationStyle) => void;
}

/**
 * 应用落盘偏好的单一家。默认值为未 hydrate 前的初值；启动时由 hydratePreferences 从主进程 DB
 * 灌入，变更经 persistPreference 落盘（收口到 preferences 表单一源）。
 */
export const usePrefsStore = create<PrefsState & PrefsActions>()((set) => ({
  autoSummarize: false,
  prefs: { fontScale: 1, lineHeight: 1.9, maxWidth: 640 },
  lastHighlightStyle: "yellow",
  setAutoSummarize: (autoSummarize) => {
    persistPreference({ key: "autoSummarize", value: autoSummarize });
    set({ autoSummarize });
  },
  updatePrefs: (patch) =>
    set((s) => {
      const prefs = { ...s.prefs, ...patch };
      persistPreference({ key: "readerPrefs", value: prefs });
      return { prefs };
    }),
  setLastHighlightStyle: (lastHighlightStyle) => {
    persistPreference({ key: "lastHighlightStyle", value: lastHighlightStyle });
    set({ lastHighlightStyle });
  },
}));
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/store/prefs-store.test.ts`
Expected: PASS（2 个用例）

- [ ] **Step 5: 切 prefs 消费方到 usePrefsStore**

`reader/ReaderPrefs.tsx`（行 50–51）——import 换 `usePrefsStore`：

```ts
const prefs = usePrefsStore((s) => s.prefs);
const updatePrefs = usePrefsStore((s) => s.updatePrefs);
```

`reader/EpubReader.tsx`（行 37）——`prefs` 切 prefs-store：

```ts
const prefs = usePrefsStore((s) => s.prefs);
```

顶部新增 `import { usePrefsStore } from "@renderer/store/prefs-store";`；此时 EpubReader 已不再用 reader-store（导航走 navigation、选区/滚动走 annotation、prefs 走 prefs），删 `import { useReaderStore } ...`。

`reader/SelectionToolbar.tsx`（行 26）——`lastHighlightStyle` 切 prefs：

```ts
const lastStyle = usePrefsStore((s) => s.lastHighlightStyle);
```

顶部新增 `import { usePrefsStore } ...`；此时 SelectionToolbar 已不再用 reader-store（navigation+annotation+prefs），删 `import { useReaderStore } ...`。

`reader/NoteModal.tsx`（行 24）——`lastHighlightStyle` 切 prefs：

```ts
const lastStyle = usePrefsStore((s) => s.lastHighlightStyle);
```

顶部新增 `import { usePrefsStore } ...`；删 `import { useReaderStore } ...`（不再使用）。

`reader/HighlightStyleBar.tsx`（行 19）——`setLastHighlightStyle` 切 prefs：

```ts
const setLastHighlightStyle = usePrefsStore((s) => s.setLastHighlightStyle);
```

顶部新增 `import { usePrefsStore } ...`；删 `import { useReaderStore } ...`（不再使用）。

- [ ] **Step 6: hydrate-preferences 改走 prefs-store**

修改 `src/renderer/store/hydrate-preferences.ts`：删 `import { useReaderStore } ...`，三个赋值统一走 prefs-store：

```ts
import { usePrefsStore } from "@renderer/store/prefs-store";

/**
 * 启动时从主进程同步快照 hydrate 偏好（缺失/损坏的 key 保持 store 默认值）。
 * 快照由 preload 在首帧前经 sendSync 取好缓存（window.api.preferences.getAll() 同步返回）。
 * 用 setState 直写（非 action）以免触发各 action 的回写持久化。在 App 挂载时调用一次。
 * 注：colorMode 不在此处处理——已由 theme-store 在初始化时从同一份快照同步接管。
 */
export function hydratePreferences(): void {
  if (typeof window === "undefined" || !window.api?.preferences) return;
  const snap = window.api.preferences.getAll();
  if (snap.readerPrefs) usePrefsStore.setState({ prefs: snap.readerPrefs });
  if (snap.lastHighlightStyle) {
    usePrefsStore.setState({ lastHighlightStyle: snap.lastHighlightStyle });
  }
  if (snap.autoSummarize !== undefined) {
    usePrefsStore.setState({ autoSummarize: snap.autoSummarize });
  }
}
```

- [ ] **Step 7: 删除 reader-store（含死字段 sidebarOpen）**

此时 reader-store 仅剩 `sidebarOpen`/`setSidebarOpen`（零消费方死字段）与已迁空壳。直接删除两个文件：

```bash
git rm src/renderer/store/reader-store.ts src/renderer/store/reader-store.test.ts
```

全仓确认无残留引用：

Run: `grep -rn "useReaderStore\|reader-store\|sidebarOpen\|scrollToCfi\|requestScrollToCfi" src/renderer`
Expected: 无输出（全部已迁移/删除）。

- [ ] **Step 8: typecheck + 全量测试**

Run: `pnpm typecheck`
Expected: 无错误。

Run: `pnpm test`
Expected: PASS（navigation/annotation/chat/prefs 四 store 测试全过；reader-store.test 已删）。

- [ ] **Step 9: Commit**

```bash
git add src/renderer/store/prefs-store.ts src/renderer/store/prefs-store.test.ts \
  src/renderer/store/hydrate-preferences.ts \
  src/renderer/reader/ReaderPrefs.tsx src/renderer/reader/EpubReader.tsx \
  src/renderer/reader/SelectionToolbar.tsx src/renderer/reader/NoteModal.tsx \
  src/renderer/reader/HighlightStyleBar.tsx \
  src/renderer/store/reader-store.ts src/renderer/store/reader-store.test.ts
git commit -m "refactor(store): absorb prefs into prefs-store, delete reader-store (#10)

prefs/lastHighlightStyle 收口进 prefs-store（落盘偏好单一家），hydrate 只碰
prefs-store；删死字段 sidebarOpen 与已迁空的 reader-store。完成 #10 store 边界重构。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: 手动冒烟 + ROADMAP 更新

**Files:**

- Modify: `docs/superpowers/ROADMAP.md`

- [ ] **Step 1: 手动冒烟（pnpm start）**

Run: `pnpm start`（会阻塞，开发模式启动）。逐项核对行为与重构前一致：

- 书库 → 打开书（进 reader、清空上本 AI 会话）→ 返回书库。
- 切章（ChapterList / 滚动驱动当前章）。
- 选区 → SelectionToolbar 出现 → 高亮（HighlightStyleBar 套用上次样式）/ 笔记（NoteModal，长笔记滚动不丢）。
- AI 面板：选区起 action → 草稿 chips/text 注入 → 面板开。
- 阅读偏好：字号/行高/版心调节即时生效且重启后保留（落盘）。
- 标注侧栏点击 → 滚动跳转到该 CFI（scrollCommand）。

- [ ] **Step 2: 更新 ROADMAP**

`docs/superpowers/ROADMAP.md` 架构债表（约行 106）`#10` 行 `🔴`→`✅`，备注简述：「reader-store 拆为 navigation/annotation/chat + 偏好收口 prefs-store，删死字段 sidebarOpen」。

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/ROADMAP.md
git commit -m "docs(roadmap): mark #10 renderer store refactor delivered

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Self-Review

**1. Spec 覆盖（对照 spec §3–§7）：**

- 4 store 划分（navigation/annotation/chat + prefs 吸收）→ Task 1–4。✅
- openBook 内联协调清会话（§5.1）→ Task 2 Step 3 + 协调测试。✅
- scrollToCfi→scrollCommand 命令信号（§5.2）→ Task 3。✅
- persist/hydrate 迁移（§5.3）→ Task 4 Step 3/6。✅
- sidebarOpen 死字段删除（§5.4）→ Task 4 Step 7。✅
- lastHighlightStyle 归 prefs（§5.5）→ Task 4 Step 5。✅
- 消费方映射（§6）全部覆盖：App/ChapterList/ReaderView/EpubReader/LibraryView/SelectionToolbar/NoteModal/HighlightStyleBar/AnnotationsList/ReaderPrefs/AIPanel/Composer/SummaryPill/use-ai-actions/ipc-chat-transport/hydrate-preferences。✅
- 测试策略（§7）→ 每 store 单测 + openBook 协调测试。✅

**2. 占位扫描：** 无 TBD/TODO；每个改动给出精确 old/new 代码与行号锚点；命令与预期明确。✅

**3. 类型/命名一致性：** store hook 名（useNavigationStore/useAnnotationStore/useChatStore/usePrefsStore）、初值常量（NAVIGATION_INITIAL/ANNOTATION_INITIAL/CHAT_INITIAL）、字段改名（scrollToCfi→scrollCommand、requestScrollToCfi→requestScroll）跨 Task 一致。reader-store 渐进瘦身：Task 1 删 chat 字段、Task 2 删 navigation 字段、Task 3 删 annotation 字段与类型、Task 4 删剩余（prefs/lastHighlightStyle/sidebarOpen）并删文件——无字段遗漏、无两份真相。✅

**4. 顺序正确性：** chat-store（Task 1）先于 navigation-store（Task 2），满足 `navigation.openBook` 调 `useChatStore` 的依赖。每个 Task 结束 typecheck+test 全绿、reader-store 仍可编译（保留未迁字段）。✅
