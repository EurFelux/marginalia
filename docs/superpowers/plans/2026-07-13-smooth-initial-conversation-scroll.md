# Smooth Initial Conversation Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

> **已被推翻（2026-08-06）：** 本计划让打开会话的一次性滚动使用 `smooth`，但 smooth 的中间帧
> 会落在无限列表「接近顶部」的阈值内，使打开长会话时必然多触发一页历史加载，而该加载的锚点恢复
> 又直接写 `scrollTop`、把动画取消在半途——首屏因此永远停不到底部。`conversationOpenScrollBehavior()`
> 现返回 `"instant"`。本文件仅作历史记录，勿据此改回 smooth。

**Goal:** Preserve smooth scrolling for the one-shot bottom positioning after an existing conversation renders, while keeping every message-update and streaming follow scroll instant.

**Architecture:** Keep both behavior choices in the pure renderer scroll policy module. `AIPanel` continues to own timing and DOM access: message updates call the existing policy, while the conversation-opening timeout calls a dedicated one-shot policy after stopping the active stream and waiting for layout.

**Tech Stack:** TypeScript 6, React 19, Vitest 4, Electron renderer DOM APIs

## Global Constraints

- Every message-update scroll, including streaming chunks, must use `behavior: "instant"`.
- Only the one-shot scroll after opening and rendering conversation history may use `behavior: "smooth"`.
- While a conversation is opening, the ordinary message-update policy must not request a scroll.
- Keep the existing `stop()` call and 100ms layout delay; do not add a `scrollend` state machine or correction timer.
- Do not add `useCallback` or `useMemo`; React Compiler handles memoization.

---

### Task 1: Separate the conversation-opening scroll policy

**Files:**

- Modify: `src/renderer/ai/scroll-follow.test.ts`
- Modify: `src/renderer/ai/scroll-follow.ts`
- Modify: `src/renderer/ai/AIPanel.tsx`

**Interfaces:**

- Consumes: `messageScrollBehavior(update: MessageScrollUpdate): "instant" | null`
- Produces: `conversationOpenScrollBehavior(): "smooth"`

- [x] **Step 1: Write the failing policy test**

Add `conversationOpenScrollBehavior` to the import from `./scroll-follow`, then add:

```ts
describe("conversationOpenScrollBehavior", () => {
  it("uses smooth scrolling for the one-shot history render", () => {
    expect(conversationOpenScrollBehavior()).toBe("smooth");
  });
});
```

- [x] **Step 2: Run the focused test and verify RED**

Run: `pnpm test src/renderer/ai/scroll-follow.test.ts`

Expected: FAIL because `conversationOpenScrollBehavior` is not exported by `scroll-follow.ts`.

- [x] **Step 3: Implement the minimal policy**

Add to `src/renderer/ai/scroll-follow.ts`:

```ts
export function conversationOpenScrollBehavior(): "smooth" {
  return "smooth";
}
```

- [x] **Step 4: Use the policy in the opening path**

Import `conversationOpenScrollBehavior` in `AIPanel.tsx`, then update only the conversation-opening timeout:

```ts
// 等 React 渲染 + Streamdown/markdown 高度基本稳定后再单次 smooth 滚底；
// 该路径已停止当前流，不会与 chunk 跟随竞争。
setTimeout(() => {
  if (cancelled) return;
  const el = scrollRef.current;
  if (el) {
    followBottomRef.current = true;
    el.scrollTo({ top: el.scrollHeight, behavior: conversationOpenScrollBehavior() });
  }
  isOpeningRef.current = false;
}, 100);
```

Do not change the message-update effect; it must continue to receive `"instant"` from `messageScrollBehavior`.

- [x] **Step 5: Run focused and repository verification**

Run:

```bash
pnpm test src/renderer/ai/scroll-follow.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

Expected: 9 focused tests pass; type checking, lint, formatting, and the full suite all exit successfully.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/renderer/ai/scroll-follow.test.ts src/renderer/ai/scroll-follow.ts src/renderer/ai/AIPanel.tsx docs/superpowers/plans/2026-07-13-smooth-initial-conversation-scroll.md
git commit -m "fix(ai): smooth initial conversation scroll"
```

### Task 2: Prevent an earlier instant scroll during conversation switching

**Files:**

- Modify: `src/renderer/ai/scroll-follow.test.ts`
- Modify: `src/renderer/ai/scroll-follow.ts`
- Modify: `src/renderer/ai/AIPanel.tsx`

**Interfaces:**

- Consumes: `isOpeningRef.current: boolean`
- Produces: required `MessageScrollUpdate.openingConversation: boolean`

- [x] **Step 1: Reproduce the race in the policy test**

Pass `openingConversation: true` with a changed last message and assert that
`messageScrollBehavior()` returns `null` rather than `"instant"`.

- [x] **Step 2: Verify RED**

Run: `pnpm test src/renderer/ai/scroll-follow.test.ts`

Observed: FAIL because the policy returned `"instant"`; the other 8 tests passed.

- [x] **Step 3: Add the opening gate and require component wiring**

Add the required `openingConversation` field to `MessageScrollUpdate`, reject scrolling when it is
true, and pass `isOpeningRef.current` from the `AIPanel` message-update effect.

- [x] **Step 4: Verify GREEN and type safety**

Run: `pnpm test src/renderer/ai/scroll-follow.test.ts && pnpm typecheck`

Observed: 9 tests passed and type checking exited successfully.
