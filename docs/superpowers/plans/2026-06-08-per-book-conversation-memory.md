# 每本书记忆上次会话 + activeConversationId 派生化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让每本书记住上次 active 的会话（zustand persist，纯渲染层），把 `activeConversationId` 从独立全局字段改为 `activeByBook[currentBookId]` 派生，并修复切书后上本书会话残留在 AIPanel 的 bug。

**Architecture:** `chat-store` 新增 `activeByBook: Record<bookId, convId|null>` 作为唯一真相（persist 仅持久化它）；删除独立 `activeConversationId` 字段，改由 `useActiveConversationId()`（组件）/`getActiveConversationId()`（非响应式）派生；切书经 `resetForBookSwitch()` 仅清 `openCommand`；开书恢复逻辑抽出纯函数 `pickRestoreTarget` 决定「命中记忆 / 空态 / 回落最新 / 无会话」。零主进程改动。

**Tech Stack:** React 19 + zustand 5（`persist` + `createJSONStorage`）+ vitest 4（node 环境，hook 逻辑抽纯函数测）。

**Spec:** `docs/superpowers/specs/2026-06-08-per-book-active-conversation-memory-design.md`

**执行说明（紧耦合重构）：** 删 `activeConversationId` 字段会牵动全部引用，中间态无法编译。故 Task 1–3 是**一个原子重构**的三部分，**连续改完**，在 **Task 4 统一验证**（`typecheck`/`lint`/`test` 全绿）。各 Task 内不单独跑 `pnpm test`（会因未完成而红）。

---

### Task 1: 重构 `chat-store`（activeByBook + persist + 派生 + resetForBookSwitch）

**Files:**

- Modify: `src/renderer/store/chat-store.ts`（整体重写）

- [ ] **Step 1: 用以下内容整体替换 `src/renderer/store/chat-store.ts`**

```ts
import { create } from "zustand";
import { persist, createJSONStorage, type StateStorage } from "zustand/middleware";
import type { Chip } from "@shared/chat";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { useNavigationStore } from "@renderer/store/navigation-store";

interface ChatState {
  draftText: string;
  draftChips: Chip[];
  /**
   * 一次性命令信号（非状态）：nonce 递增触发 AIPanel 载入该会话历史。
   * 与「当前 active 会话」解耦——发消息路径只写记忆槽、不发本命令，
   * 故发消息不会触发历史重载（避免覆盖刚流式出来的内容）。镜像 annotation-store.scrollCommand。
   */
  openCommand: { conversationId: string; nonce: number } | null;
  /** 常驻摘要 toggle（spec §6）：true=on 随下条消息发送。 */
  summaryChips: { chapter: boolean; book: boolean };
  /**
   * 每本书上次 active 的会话（视图记忆，唯一真相 + persist 持久化的唯一字段）。
   * 值 = 会话 id；null = 上次停在「将开新会话」空态；缺键 = 该书从无记忆（回落最新）。
   * 「当前 active 会话」由此派生（见 useActiveConversationId / getActiveConversationId），不独立存储。
   */
  activeByBook: Record<string, string | null>;
}
interface ChatActions {
  /** 设当前书的 active（写记忆槽）；id=null 同时清 openCommand（其载入命令失效）。 */
  setActiveConversation: (id: string | null) => void;
  setDraftText: (text: string) => void;
  setDraftChips: (chips: Chip[]) => void;
  /** 重开会话：发命令信号（触发载历史）+ 写记忆槽 + 开面板（经 prefs-store 布局）。 */
  openConversation: (id: string) => void;
  /** 开书恢复会话：同 openConversation 但不强制开面板（spec §7）。 */
  restoreConversation: (id: string) => void;
  setSummaryChip: (kind: "chapter" | "book", on: boolean) => void;
  /** 「将开启新会话」预亮（spec §6）：新对话按钮 / 开书无会话。 */
  setSummaryChipsPreset: () => void;
  /** 回落全 off。 */
  resetSummaryChips: () => void;
  /** 切书重置：仅清残留 openCommand（避免 AIPanel 重挂重放上本书会话）；保留 activeByBook 与草稿。 */
  resetForBookSwitch: () => void;
}

export const CHAT_INITIAL: ChatState = {
  draftText: "",
  draftChips: [],
  openCommand: null,
  summaryChips: { chapter: false, book: false },
  activeByBook: {},
};

/** 写当前书的记忆槽；无当前书（library 态）则原样返回。 */
function rememberSlot(
  map: Record<string, string | null>,
  id: string | null,
): Record<string, string | null> {
  const bookId = useNavigationStore.getState().currentBookId;
  return bookId ? { ...map, [bookId]: id } : map;
}

// headless 测试（vitest 跑 Electron node 运行时）无 DOM，localStorage 未定义 → noop 降级，
// persist 仅内存、不抛错；renderer 真实环境用 window.localStorage。
const noopStorage: StateStorage = {
  getItem: () => null,
  setItem: () => {},
  removeItem: () => {},
};
const safeStorage = createJSONStorage(() =>
  typeof localStorage !== "undefined" ? localStorage : noopStorage,
);

export const useChatStore = create<ChatState & ChatActions>()(
  persist(
    (set) => ({
      ...CHAT_INITIAL,
      setActiveConversation: (id) =>
        set((s) => ({
          activeByBook: rememberSlot(s.activeByBook, id),
          ...(id === null ? { openCommand: null } : {}),
        })),
      setDraftText: (draftText) => set({ draftText }),
      setDraftChips: (draftChips) => set({ draftChips }),
      openConversation: (id) => {
        usePrefsStore.getState().updateLayout({ panelOpen: true });
        return set((s) => ({
          openCommand: { conversationId: id, nonce: (s.openCommand?.nonce ?? 0) + 1 },
          summaryChips: { chapter: false, book: false },
          activeByBook: rememberSlot(s.activeByBook, id),
        }));
      },
      restoreConversation: (id) =>
        set((s) => ({
          openCommand: { conversationId: id, nonce: (s.openCommand?.nonce ?? 0) + 1 },
          summaryChips: { chapter: false, book: false },
          activeByBook: rememberSlot(s.activeByBook, id),
        })),
      setSummaryChip: (kind, on) =>
        set((s) => ({ summaryChips: { ...s.summaryChips, [kind]: on } })),
      setSummaryChipsPreset: () => set({ summaryChips: { chapter: true, book: true } }),
      resetSummaryChips: () => set({ summaryChips: { chapter: false, book: false } }),
      resetForBookSwitch: () => set({ openCommand: null }),
    }),
    {
      name: "marginalia-chat",
      storage: safeStorage,
      partialize: (s) => ({ activeByBook: s.activeByBook }),
    },
  ),
);

/** 组件用：当前 active 会话 = activeByBook[currentBookId]（派生）。 */
export function useActiveConversationId(): string | null {
  const bookId = useNavigationStore((s) => s.currentBookId);
  return useChatStore((s) => (bookId != null ? (s.activeByBook[bookId] ?? null) : null));
}

/** action / transport 等非响应式语境用。 */
export function getActiveConversationId(): string | null {
  const bookId = useNavigationStore.getState().currentBookId;
  return bookId != null ? (useChatStore.getState().activeByBook[bookId] ?? null) : null;
}
```

> 不在此 Task 跑测试（读取点未迁移，typecheck 会在引用处红）。继续 Task 2。

---

### Task 2: 迁移所有 `activeConversationId` 读取点 + `openBook`

**Files:**

- Modify: `src/renderer/store/navigation-store.ts:39`
- Modify: `src/renderer/ai/AIPanel.tsx`（import + line 29）
- Modify: `src/renderer/reader/ConversationsTab.tsx`（import + line 31 + line 43）
- Modify: `src/renderer/ai/ipc-chat-transport.ts`（import + line 65）
- Modify: `src/renderer/ai/use-restore-conversation.ts`（整体重写，抽 `pickRestoreTarget`）

- [ ] **Step 1: `navigation-store.ts` openBook 改调 resetForBookSwitch**

把 line 39 这行：

```ts
useChatStore.getState().setActiveConversation(null); // 开书清上本会话（跨 store 协调）
```

替换为：

```ts
useChatStore.getState().resetForBookSwitch(); // 切书清残留 openCommand；active 由 activeByBook 派生恢复
```

- [ ] **Step 2: `AIPanel.tsx` 用派生 hook**

import 行（原 `import { useChatStore } from "@renderer/store/chat-store";`）改为：

```ts
import { useChatStore, useActiveConversationId } from "@renderer/store/chat-store";
```

把 line 29：

```ts
const activeConversationId = useChatStore((s) => s.activeConversationId);
```

替换为：

```ts
const activeConversationId = useActiveConversationId();
```

（`activeTitle`、`useEffect([activeConversationId])` 等沿用该局部变量，无需再改。）

- [ ] **Step 3: `ConversationsTab.tsx` 高亮用 activeByBook、删除判定用 getter**

import 行（原 `import { useChatStore } from "@renderer/store/chat-store";`）改为：

```ts
import { useChatStore, getActiveConversationId } from "@renderer/store/chat-store";
```

把 line 31：

```ts
const activeId = useChatStore((s) => s.activeConversationId);
```

替换为（组件已有 `bookId` prop）：

```ts
const activeId = useChatStore((s) => s.activeByBook[bookId] ?? null);
```

把 deleteConvo.onSuccess 内 line 42-43 起的：

```ts
      const s = useChatStore.getState();
      if (s.activeConversationId === c.id) {
```

替换为：

```ts
      const s = useChatStore.getState();
      if (getActiveConversationId() === c.id) {
```

- [ ] **Step 4: `ipc-chat-transport.ts` 懒建读取用 getter**

import 行（原 `import { useChatStore } from "@renderer/store/chat-store";`）改为：

```ts
import { useChatStore, getActiveConversationId } from "@renderer/store/chat-store";
```

把 line 65：

```ts
let conversationId = useChatStore.getState().activeConversationId;
```

替换为：

```ts
let conversationId = getActiveConversationId();
```

（line 70 的 `useChatStore.getState().setActiveConversation(convo.id);` 保留——写记忆槽。）

- [ ] **Step 5: 整体重写 `src/renderer/ai/use-restore-conversation.ts`**

```ts
import { useEffect } from "react";
import { useChatStore } from "@renderer/store/chat-store";
import { createLogger } from "@renderer/logger";

const log = createLogger("chat");

type RestoreTarget = { kind: "restore"; id: string } | { kind: "empty" };

/**
 * 据该书会话列表（updatedAt 倒序）+ 记忆值，决定开书该恢复的目标（纯函数，便于测试）。
 * 优先级：命中记忆 > null 空态 > 回落最新 > 无会话空态。
 * - remembered=string 且仍在 list → 精确恢复上次正看的；
 * - remembered=null → 上次停在「将开新会话」空态，忠实还原（empty）；
 * - remembered 失效 / 缺键 → 回落 list[0]（最新）；list 空 → empty。
 */
export function pickRestoreTarget(
  list: readonly { id: string }[],
  remembered: string | null | undefined,
): RestoreTarget {
  const has = (id: string) => list.some((c) => c.id === id);
  if (typeof remembered === "string" && has(remembered)) return { kind: "restore", id: remembered };
  if (remembered === null) return { kind: "empty" };
  const latest = list[0];
  return latest ? { kind: "restore", id: latest.id } : { kind: "empty" };
}

/**
 * 开书恢复会话（spec §7）：取该书会话列表，按 pickRestoreTarget 决定恢复哪个 /
 * 还原空态。命中/回落 → restoreConversation（发 openCommand 载历史）；
 * 空态 → 置 active null（写槽 null + 清 openCommand）+ 预亮摘要 chips。
 */
export function useRestoreConversation(bookId: string | null) {
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    void window.api.chat.conversations
      .listByBook({ bookId })
      .then((list) => {
        if (cancelled) return;
        const s = useChatStore.getState();
        const target = pickRestoreTarget(list, s.activeByBook[bookId]);
        if (target.kind === "restore") {
          s.restoreConversation(target.id);
        } else {
          s.setActiveConversation(null);
          s.setSummaryChipsPreset();
        }
      })
      .catch((err: unknown) => log.warn("restore conversation failed", err));
    return () => {
      cancelled = true;
    };
  }, [bookId]);
}
```

> 此时业务侧 `activeConversationId` 引用已全部清除（store 字段已在 Task 1 删除）。typecheck 业务代码应已绿；测试仍引用旧字段 → Task 3 修。

---

### Task 3: 改写测试（断言 activeByBook / 派生 / resetForBookSwitch）+ 新增 pickRestoreTarget 测试

**Files:**

- Modify: `src/renderer/store/chat-store.test.ts`
- Modify: `src/renderer/store/navigation-store.test.ts:32-36`
- Modify: `src/renderer/ai/ipc-chat-transport.test.ts`（line 127 / 179 / 199 区域）
- Create: `src/renderer/ai/use-restore-conversation.test.ts`

- [ ] **Step 1: 整体替换 `src/renderer/store/chat-store.test.ts`**

```ts
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useChatStore, CHAT_INITIAL, getActiveConversationId } from "@renderer/store/chat-store";
import { useNavigationStore, NAVIGATION_INITIAL } from "@renderer/store/navigation-store";
import { usePrefsStore, PREFS_INITIAL } from "@renderer/store/prefs-store";
import type { Chip } from "@shared/chat";

const BOOK = "book-1";

beforeEach(() => {
  useChatStore.setState(CHAT_INITIAL);
  usePrefsStore.setState(PREFS_INITIAL);
  // active 派生 + rememberSlot 依赖 currentBookId，测试默认置于某本书的 reader 态
  useNavigationStore.setState({ ...NAVIGATION_INITIAL, view: "reader", currentBookId: BOOK });
});

describe("chat-store: active = activeByBook 派生", () => {
  it("setActiveConversation writes the current book's slot", () => {
    useChatStore.getState().setActiveConversation("conv1");
    expect(useChatStore.getState().activeByBook[BOOK]).toBe("conv1");
    expect(getActiveConversationId()).toBe("conv1");
  });
  it("setActiveConversation(null) clears slot and openCommand", () => {
    useChatStore.getState().openConversation("c1"); // 设 openCommand + 槽
    useChatStore.getState().setActiveConversation(null);
    expect(useChatStore.getState().activeByBook[BOOK]).toBeNull();
    expect(useChatStore.getState().openCommand).toBeNull();
    expect(getActiveConversationId()).toBeNull();
  });
  it("getActiveConversationId is null in library (no current book)", () => {
    useChatStore.getState().setActiveConversation("conv1");
    useNavigationStore.setState({ ...NAVIGATION_INITIAL }); // currentBookId=null
    expect(getActiveConversationId()).toBeNull();
  });
  it("setActiveConversation is a no-op on the slot when no current book", () => {
    useNavigationStore.setState({ ...NAVIGATION_INITIAL }); // currentBookId=null
    useChatStore.getState().setActiveConversation("conv1");
    expect(useChatStore.getState().activeByBook).toEqual({});
  });
  it("setDraftText / setDraftChips update drafts", () => {
    useChatStore.getState().setDraftText("hi");
    const chip: Chip = {
      id: "selection",
      labelKey: "",
      content: "",
      tokenCount: 0,
      state: "required",
    };
    useChatStore.getState().setDraftChips([chip]);
    expect(useChatStore.getState().draftText).toBe("hi");
    expect(useChatStore.getState().draftChips).toHaveLength(1);
  });
});

describe("openConversation", () => {
  it("writes slot + opens panel + bumps openCommand nonce", () => {
    useChatStore.getState().openConversation("conv-1");
    expect(getActiveConversationId()).toBe("conv-1");
    expect(usePrefsStore.getState().layout.panelOpen).toBe(true);
    expect(useChatStore.getState().openCommand).toEqual({ conversationId: "conv-1", nonce: 1 });
    useChatStore.getState().openConversation("conv-1");
    expect(useChatStore.getState().openCommand?.nonce).toBe(2); // 同会话重开也递增 → 触发重载
  });
  it("resets summaryChips to off when opening existing conversation", () => {
    useChatStore.getState().setSummaryChipsPreset();
    useChatStore.getState().openConversation("conv-1");
    expect(useChatStore.getState().summaryChips).toEqual({ chapter: false, book: false });
  });
});

describe("restoreConversation", () => {
  it("writes slot + bumps openCommand nonce + does NOT open panel", () => {
    useChatStore.getState().restoreConversation("conv-restore");
    expect(getActiveConversationId()).toBe("conv-restore");
    expect(useChatStore.getState().openCommand).toEqual({
      conversationId: "conv-restore",
      nonce: 1,
    });
    expect(usePrefsStore.getState().layout.panelOpen).toBe(false);
  });
  it("bumps nonce on repeated restoreConversation", () => {
    useChatStore.getState().restoreConversation("conv-restore");
    useChatStore.getState().restoreConversation("conv-restore");
    expect(useChatStore.getState().openCommand?.nonce).toBe(2);
  });
});

describe("resetForBookSwitch", () => {
  it("clears openCommand but keeps activeByBook and drafts", () => {
    useChatStore.getState().openConversation("conv-a"); // 设 openCommand + 槽
    useChatStore.getState().setDraftText("draft kept");
    useChatStore.getState().resetForBookSwitch();
    const s = useChatStore.getState();
    expect(s.openCommand).toBeNull();
    expect(s.activeByBook[BOOK]).toBe("conv-a"); // 记忆保留
    expect(s.draftText).toBe("draft kept"); // 草稿不清（跨卸载存活）
  });
});

describe("summaryChips state machine", () => {
  it("defaults to off, presets both on, resets to off", () => {
    expect(useChatStore.getState().summaryChips).toEqual({ chapter: false, book: false });
    useChatStore.getState().setSummaryChipsPreset();
    expect(useChatStore.getState().summaryChips).toEqual({ chapter: true, book: true });
    useChatStore.getState().resetSummaryChips();
    expect(useChatStore.getState().summaryChips).toEqual({ chapter: false, book: false });
  });
  it("toggles a single kind", () => {
    useChatStore.getState().setSummaryChip("chapter", true);
    expect(useChatStore.getState().summaryChips.chapter).toBe(true);
    expect(useChatStore.getState().summaryChips.book).toBe(false);
  });
});

describe("persist", () => {
  it("partialize persists only activeByBook", () => {
    useChatStore.setState({ activeByBook: { b: "c" }, draftText: "x" });
    // @ts-expect-error 访问 persist 内部 options 仅为断言形状
    const partial = useChatStore.persist.getOptions().partialize?.(useChatStore.getState());
    expect(partial).toEqual({ activeByBook: { b: "c" } });
  });
  it("rehydrates activeByBook from storage", () => {
    const store: Record<string, string> = {
      "marginalia-chat": JSON.stringify({ state: { activeByBook: { b9: "c9" } }, version: 0 }),
    };
    vi.stubGlobal("localStorage", {
      getItem: (k: string) => store[k] ?? null,
      setItem: (k: string, v: string) => {
        store[k] = v;
      },
      removeItem: (k: string) => {
        delete store[k];
      },
    });
    void useChatStore.persist.rehydrate();
    expect(useChatStore.getState().activeByBook).toEqual({ b9: "c9" });
    vi.unstubAllGlobals();
  });
});
```

- [ ] **Step 2: `navigation-store.test.ts` 改 openBook 协调断言（line 32-36）**

把：

```ts
it("openBook clears active conversation (cross-store coordination)", () => {
  useChatStore.getState().setActiveConversation("conv1");
  useNavigationStore.getState().openBook("b2");
  expect(useChatStore.getState().activeConversationId).toBeNull();
});
```

替换为：

```ts
it("openBook clears stale openCommand but keeps per-book memory", () => {
  useChatStore.setState({
    activeByBook: { b2: "conv-b2" },
    openCommand: { conversationId: "stale", nonce: 1 },
  });
  useNavigationStore.getState().openBook("b2");
  expect(useChatStore.getState().openCommand).toBeNull(); // 残留命令被清（修 bug）
  expect(useChatStore.getState().activeByBook.b2).toBe("conv-b2"); // 记忆保留
});
```

- [ ] **Step 3: `ipc-chat-transport.test.ts` 改 3 处字段引用**

先 Read 该文件 line 110-205，确认两个用例 setup 的 `currentBookId` 值（sendMessages 读它；记为 `<BOOK>`）。然后：

把 line 127：

```ts
useChatStore.setState({ ...CHAT_INITIAL, activeConversationId: "existing-conv" });
```

替换为（用该用例 setup 的 currentBookId）：

```ts
    useChatStore.setState({ ...CHAT_INITIAL, activeByBook: { [<BOOK>]: "existing-conv" } });
```

把 line 179：

```ts
useChatStore.setState({ ...CHAT_INITIAL, activeConversationId: null });
```

替换为：

```ts
useChatStore.setState({ ...CHAT_INITIAL, activeByBook: {} });
```

把 line 199：

```ts
expect(useChatStore.getState().activeConversationId).toBe("lazy-conv");
```

替换为（import `getActiveConversationId`）：

```ts
expect(getActiveConversationId()).toBe("lazy-conv");
```

并把顶部 import 补上 `getActiveConversationId`：

```ts
import { useChatStore, CHAT_INITIAL, getActiveConversationId } from "@renderer/store/chat-store";
```

（line 175 `expect(payload).not.toHaveProperty("activeConversationId")` 是断言 IPC payload 不含该键，与 store 字段无关，**保留不动**。）

- [ ] **Step 4: 新建 `src/renderer/ai/use-restore-conversation.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { pickRestoreTarget } from "@renderer/ai/use-restore-conversation";

// listByBook 已按 updatedAt 倒序，list[0] 为最新
const list = [{ id: "c3" }, { id: "c2" }, { id: "c1" }];

describe("pickRestoreTarget", () => {
  it("hits remembered when it still exists", () => {
    expect(pickRestoreTarget(list, "c2")).toEqual({ kind: "restore", id: "c2" });
  });
  it("falls back to latest when remembered is missing (deleted)", () => {
    expect(pickRestoreTarget(list, "gone")).toEqual({ kind: "restore", id: "c3" });
  });
  it("restores empty state when remembered is null (last left on new-conversation)", () => {
    expect(pickRestoreTarget(list, null)).toEqual({ kind: "empty" });
  });
  it("falls back to latest when no memory (undefined key)", () => {
    expect(pickRestoreTarget(list, undefined)).toEqual({ kind: "restore", id: "c3" });
  });
  it("empty when book has no conversations", () => {
    expect(pickRestoreTarget([], undefined)).toEqual({ kind: "empty" });
  });
});
```

---

### Task 4: 验证 + changeset + 提交

**Files:**

- Create: `.changeset/<random-name>.md`

- [ ] **Step 1: typecheck**

Run: `pnpm typecheck`
Expected: PASS（无 `activeConversationId` 残留引用报错）

- [ ] **Step 2: lint**

Run: `pnpm lint`
Expected: PASS

- [ ] **Step 3: 全量测试**

Run: `pnpm test`
Expected: PASS（chat-store / navigation-store / ipc-chat-transport / use-restore-conversation 全绿）

- [ ] **Step 4: 写 changeset（用户向英文 changelog）**

先看一个既有 changeset 的 frontmatter 格式：`ls .changeset/*.md` 取一个非 `README.md` 文件参考包名与 bump 级别写法。新建 `.changeset/per-book-conversation-memory.md`：

```markdown
---
"marginalia": patch
---

Remember each book's last-active AI conversation and restore it on reopen, and fix the previous book's conversation lingering in the AI panel after switching books.
```

（包名以既有 changeset / `package.json` 的 `name` 为准；若既有用 `minor` 视改动定，新功能可用 `minor`。）

- [ ] **Step 5: 提交**

```bash
git add src/renderer/store/chat-store.ts src/renderer/store/navigation-store.ts \
  src/renderer/ai/AIPanel.tsx src/renderer/reader/ConversationsTab.tsx \
  src/renderer/ai/ipc-chat-transport.ts src/renderer/ai/use-restore-conversation.ts \
  src/renderer/store/chat-store.test.ts src/renderer/store/navigation-store.test.ts \
  src/renderer/ai/ipc-chat-transport.test.ts src/renderer/ai/use-restore-conversation.test.ts \
  .changeset/per-book-conversation-memory.md
git commit -m "feat: remember per-book active conversation; derive activeConversationId; fix stale conversation on book switch"
```

> 注意：**只 add 上述文件**，不要带上工作树里无关的 `CLAUDE.md` 改动（非本次产物）。prek hook 若改动文件并中止，重新 `git add` 被改文件再执行同一 commit。

---

## 自审记录

- **Spec 覆盖**：§3 数据模型→T1；§3.2 派生→T1（hook/getter）；§3.3 persist→T1 + T3(persist 测试)；§4.1-4.3 写入/resetForBookSwitch→T1；§4.4 读取点→T2；§5 恢复+pickRestoreTarget→T2 + T3 测试；§6 不碰主进程→全程零 IPC/迁移；§7 边界（noopStorage/库态派生）→T1 + T3；§8 测试→T3；§9 范围外→未触碰 draft 作用域（resetForBookSwitch 仅清 openCommand，T3 有「草稿保留」断言）。
- **类型一致性**：`activeByBook`/`rememberSlot`/`resetForBookSwitch`/`useActiveConversationId`/`getActiveConversationId`/`pickRestoreTarget` 命名在 T1-T3 一致；`pickRestoreTarget` 返回 `{kind:"restore",id}|{kind:"empty"}` 在定义与测试一致。
- **占位**：无 TODO/TBD；唯一运行期填充是 ipc-chat-transport.test 的 `<BOOK>`（执行时 Read 确认实际值，已在 T3S3 写明步骤）。
