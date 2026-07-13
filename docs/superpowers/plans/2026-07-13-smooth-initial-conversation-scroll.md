# Smooth Initial Conversation Scroll Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Preserve smooth scrolling for the one-shot bottom positioning after an existing conversation renders, while keeping every message-update and streaming follow scroll instant.

**Architecture:** Keep both behavior choices in the pure renderer scroll policy module. `AIPanel` continues to own timing and DOM access: message updates call the existing policy, while the conversation-opening timeout calls a dedicated one-shot policy after stopping the active stream and waiting for layout.

**Tech Stack:** TypeScript 6, React 19, Vitest 4, Electron renderer DOM APIs

## Global Constraints

- Every message-update scroll, including streaming chunks, must use `behavior: "instant"`.
- Only the one-shot scroll after opening and rendering conversation history may use `behavior: "smooth"`.
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

Expected: 8 focused tests pass; type checking, lint, formatting, and the full suite all exit successfully.

- [ ] **Step 6: Commit the implementation**

```bash
git add src/renderer/ai/scroll-follow.test.ts src/renderer/ai/scroll-follow.ts src/renderer/ai/AIPanel.tsx docs/superpowers/plans/2026-07-13-smooth-initial-conversation-scroll.md
git commit -m "fix(ai): smooth initial conversation scroll"
```
