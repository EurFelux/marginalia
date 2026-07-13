# Streaming Scroll Follow Revision Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make resumed chat following stable by removing smooth animations from automatic message scrolling and using a four-pixel bottom measurement tolerance.

**Architecture:** Replace the boolean message-scroll helper with a pure decision that returns `"instant"` for an allowed automatic update and `null` otherwise. `AIPanel` passes that decision directly to `scrollTo`, so tests cover both whether a scroll occurs and which behavior it uses.

**Tech Stack:** TypeScript 6, React 19 with React Compiler, Vitest 4, Base UI `ScrollArea`

## Global Constraints

- Every automatic message-update scroll uses `behavior: "instant"`; no automatic path uses `smooth`.
- Bottom detection uses a `4px` tolerance only for DOM measurement and zoom/rounding effects.
- User scrolling away, history prepend anchoring, conversation opening, and explicit new-turn opt-in retain their delivered behavior.
- Do not add input-source tracking, timers, animation state, or new UI.

---

### Task 1: Return a Stable Automatic Scroll Decision

**Files:**

- Modify: `src/renderer/ai/scroll-follow.test.ts`
- Modify: `src/renderer/ai/scroll-follow.ts`
- Modify: `src/renderer/ai/AIPanel.tsx:85-108`

**Interfaces:**

- Replaces: `shouldScrollToBottom(update: MessageScrollUpdate): boolean`
- Produces: `messageScrollBehavior(update: MessageScrollUpdate): "instant" | null`
- Consumes: the existing message-update facts and follow ref from `AIPanel`

- [x] **Step 1: Rewrite the focused test for four-pixel bottom detection and instant scrolling**

Replace `src/renderer/ai/scroll-follow.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { isScrollAtBottom, messageScrollBehavior } from "./scroll-follow";

const streamingUpdate = {
  previousLength: 2,
  prependedHistory: false,
  lastMessageChanged: false,
  streamingAssistant: true,
};

describe("isScrollAtBottom", () => {
  it("accepts the bottom and measurements within four pixels", () => {
    expect(isScrollAtBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(isScrollAtBottom({ scrollHeight: 1000, scrollTop: 596.25, clientHeight: 400 })).toBe(
      true,
    );
  });

  it("does not treat a position outside the tolerance as the bottom", () => {
    expect(isScrollAtBottom({ scrollHeight: 1000, scrollTop: 595.9, clientHeight: 400 })).toBe(
      false,
    );
  });
});

describe("messageScrollBehavior", () => {
  it("uses instant scrolling for an allowed streaming chunk", () => {
    expect(messageScrollBehavior({ ...streamingUpdate, following: true })).toBe("instant");
  });

  it("does not scroll after the viewport leaves the bottom", () => {
    expect(messageScrollBehavior({ ...streamingUpdate, following: false })).toBe(null);
  });

  it("resumes instant scrolling after the viewport reaches the bottom", () => {
    const away = isScrollAtBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 });
    expect(messageScrollBehavior({ ...streamingUpdate, following: away })).toBe(null);

    const bottom = isScrollAtBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 });
    expect(messageScrollBehavior({ ...streamingUpdate, following: bottom })).toBe("instant");
  });

  it("never scrolls for initial loads or prepended history", () => {
    expect(
      messageScrollBehavior({
        ...streamingUpdate,
        following: true,
        previousLength: 0,
      }),
    ).toBe(null);
    expect(
      messageScrollBehavior({
        ...streamingUpdate,
        following: true,
        prependedHistory: true,
      }),
    ).toBe(null);
  });

  it("requires follow state for a newly appended assistant message too", () => {
    expect(
      messageScrollBehavior({
        ...streamingUpdate,
        following: false,
        lastMessageChanged: true,
      }),
    ).toBe(null);
  });
});
```

- [x] **Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm test src/renderer/ai/scroll-follow.test.ts
```

Expected: FAIL because `messageScrollBehavior` is not exported by the current implementation.

- [x] **Step 3: Implement the four-pixel, instant-only decision**

Replace `src/renderer/ai/scroll-follow.ts` with:

```ts
const BOTTOM_TOLERANCE_PX = 4;

export interface ScrollPosition {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export interface MessageScrollUpdate {
  following: boolean;
  previousLength: number;
  prependedHistory: boolean;
  lastMessageChanged: boolean;
  streamingAssistant: boolean;
}

export function isScrollAtBottom({
  scrollHeight,
  scrollTop,
  clientHeight,
}: ScrollPosition): boolean {
  return scrollHeight - scrollTop - clientHeight <= BOTTOM_TOLERANCE_PX;
}

export function messageScrollBehavior({
  following,
  previousLength,
  prependedHistory,
  lastMessageChanged,
  streamingAssistant,
}: MessageScrollUpdate): "instant" | null {
  return following &&
    previousLength > 0 &&
    !prependedHistory &&
    (lastMessageChanged || streamingAssistant)
    ? "instant"
    : null;
}
```

- [x] **Step 4: Pass the decision through `AIPanel`**

Change the helper import to `messageScrollBehavior`, then replace the boolean branch with:

```ts
const scrollBehavior = messageScrollBehavior({
  following: followBottomRef.current,
  previousLength: prev.length,
  prependedHistory,
  lastMessageChanged,
  streamingAssistant,
});
if (scrollBehavior) {
  el.scrollTo({ top: el.scrollHeight, behavior: scrollBehavior });
}
```

- [x] **Step 5: Run focused and static verification**

Run:

```bash
pnpm test src/renderer/ai/scroll-follow.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
```

Expected: all commands exit `0`; the focused test reports 7 passing tests.

- [x] **Step 6: Run the full test suite**

Run:

```bash
pnpm test
```

Expected: all test files pass with no failures.

- [ ] **Step 7: Commit the acceptance revision**

```bash
git add docs/superpowers/plans/2026-07-13-streaming-scroll-follow-revision.md \
  src/renderer/ai/scroll-follow.ts \
  src/renderer/ai/scroll-follow.test.ts \
  src/renderer/ai/AIPanel.tsx
git commit -m "fix(ai): stabilize resumed streaming scroll follow"
```
