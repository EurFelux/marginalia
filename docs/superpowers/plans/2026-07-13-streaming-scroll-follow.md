# Streaming Chat Scroll Follow Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Stop streaming assistant chunks from reclaiming the chat viewport after the user scrolls away, and resume following only when the viewport returns to the bottom.

**Architecture:** Add two pure renderer helpers: one converts DOM scroll metrics into an exact-bottom decision with a one-pixel measurement tolerance, and one decides whether a message update may scroll. `AIPanel` owns the mutable follow flag in a ref, updates it from the real `ScrollArea` viewport, opts back in on send/open, and gates its existing message effect through the helper.

**Tech Stack:** TypeScript 6, React 19 with React Compiler, Vitest 4, Base UI `ScrollArea`

## Global Constraints

- Keep business behavior in the existing renderer UI boundary; do not change stream transport or pagination.
- Do not add `useCallback` or `useMemo`; the renderer uses React Compiler.
- A viewport counts as being at the bottom only when the remaining distance is at most `1px`, solely to absorb fractional DOM measurements.
- History prepend must retain its existing anchor restoration and must never request a bottom scroll.
- Do not add wheel-, pointer-, or touch-specific detection.

---

### Task 1: Gate Streaming Scrolls With Exact-Bottom Follow State

**Files:**

- Create: `src/renderer/ai/scroll-follow.ts`
- Create: `src/renderer/ai/scroll-follow.test.ts`
- Modify: `src/renderer/ai/AIPanel.tsx:1-103,108-130,258-271,289-292`

**Interfaces:**

- Produces: `isScrollAtBottom(position: ScrollPosition): boolean`
- Produces: `shouldScrollToBottom(update: MessageScrollUpdate): boolean`
- Consumes: the `ScrollArea` viewport metrics and the existing previous/current message comparison in `AIPanel`

- [x] **Step 1: Write the failing pure regression tests**

Create `src/renderer/ai/scroll-follow.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { isScrollAtBottom, shouldScrollToBottom } from "./scroll-follow";

const streamingUpdate = {
  previousLength: 2,
  prependedHistory: false,
  lastMessageChanged: false,
  streamingAssistant: true,
};

describe("isScrollAtBottom", () => {
  it("accepts the bottom and fractional measurements within one pixel", () => {
    expect(isScrollAtBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 })).toBe(true);
    expect(isScrollAtBottom({ scrollHeight: 1000, scrollTop: 599.25, clientHeight: 400 })).toBe(
      true,
    );
  });

  it("does not treat a merely near-bottom viewport as the bottom", () => {
    expect(isScrollAtBottom({ scrollHeight: 1000, scrollTop: 598.9, clientHeight: 400 })).toBe(
      false,
    );
  });
});

describe("shouldScrollToBottom", () => {
  it("follows a streaming chunk only while bottom following is enabled", () => {
    expect(shouldScrollToBottom({ ...streamingUpdate, following: true })).toBe(true);
    expect(shouldScrollToBottom({ ...streamingUpdate, following: false })).toBe(false);
  });

  it("resumes streaming follow only after the viewport reaches the bottom", () => {
    const away = isScrollAtBottom({ scrollHeight: 1000, scrollTop: 500, clientHeight: 400 });
    expect(shouldScrollToBottom({ ...streamingUpdate, following: away })).toBe(false);

    const bottom = isScrollAtBottom({ scrollHeight: 1000, scrollTop: 600, clientHeight: 400 });
    expect(shouldScrollToBottom({ ...streamingUpdate, following: bottom })).toBe(true);
  });

  it("never scrolls for initial loads or prepended history", () => {
    expect(
      shouldScrollToBottom({
        ...streamingUpdate,
        following: true,
        previousLength: 0,
      }),
    ).toBe(false);
    expect(
      shouldScrollToBottom({
        ...streamingUpdate,
        following: true,
        prependedHistory: true,
      }),
    ).toBe(false);
  });

  it("requires follow state for a newly appended assistant message too", () => {
    expect(
      shouldScrollToBottom({
        ...streamingUpdate,
        following: false,
        lastMessageChanged: true,
      }),
    ).toBe(false);
  });
});
```

- [x] **Step 2: Run the focused test and confirm RED**

Run:

```bash
pnpm test src/renderer/ai/scroll-follow.test.ts
```

Expected: FAIL because `./scroll-follow` does not exist.

- [x] **Step 3: Add the minimal pure decision helpers**

Create `src/renderer/ai/scroll-follow.ts`:

```ts
const BOTTOM_TOLERANCE_PX = 1;

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

export function shouldScrollToBottom({
  following,
  previousLength,
  prependedHistory,
  lastMessageChanged,
  streamingAssistant,
}: MessageScrollUpdate): boolean {
  return (
    following &&
    previousLength > 0 &&
    !prependedHistory &&
    (lastMessageChanged || streamingAssistant)
  );
}
```

- [x] **Step 4: Run the focused test and confirm GREEN**

Run:

```bash
pnpm test src/renderer/ai/scroll-follow.test.ts
```

Expected: 6 tests pass.

- [x] **Step 5: Wire the follow ref and passive viewport listener into `AIPanel`**

Import the helpers:

```ts
import { isScrollAtBottom, shouldScrollToBottom } from "@renderer/ai/scroll-follow";
```

Beside `scrollRef`, initialize the follow state:

```ts
const scrollRef = useRef<HTMLDivElement | null>(null);
const followBottomRef = useRef(true);
```

Replace the message-update effect body with:

```ts
useEffect(() => {
  const el = scrollRef.current;
  if (!el) return;

  const prev = prevMessagesRef.current;
  prevMessagesRef.current = messages;
  const prependedHistory =
    prev.length > 0 && messages.length > prev.length && messages[0]?.id !== prev[0]?.id;
  const lastMessageChanged = messages.at(-1)?.id !== prev.at(-1)?.id;
  const streamingAssistant = status === "streaming" && messages.at(-1)?.role === "assistant";

  if (
    shouldScrollToBottom({
      following: followBottomRef.current,
      previousLength: prev.length,
      prependedHistory,
      lastMessageChanged,
      streamingAssistant,
    })
  ) {
    el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }
}, [messages, status]);
```

Add a separate effect after the message-update effect. Depending on `showList` ensures the listener
reattaches when the conditionally rendered chat viewport returns:

```ts
useEffect(() => {
  const el = scrollRef.current;
  if (!el) return;
  const updateFollowState = () => {
    followBottomRef.current = isScrollAtBottom(el);
  };
  updateFollowState();
  el.addEventListener("scroll", updateFollowState, { passive: true });
  return () => el.removeEventListener("scroll", updateFollowState);
}, [showList]);
```

At the start of the open-conversation effect, before loading messages, restore follow intent:

```ts
followBottomRef.current = true;
```

In the delayed open-conversation scroll, retain the same intent before the instant scroll:

```ts
followBottomRef.current = true;
el.scrollTo({ top: el.scrollHeight, behavior: "instant" });
```

Finally, opt into the new turn in `handleSend` before calling the chat hook:

```ts
const handleSend = (text: string, chips: Chip[]) => {
  followBottomRef.current = true;
  void sendMessage({ text, metadata: { contextChips: chips } });
};
```

Preserve the same new-turn behavior for every `ChatActions` entry point by assigning
`followBottomRef.current = true` before `regenerate()` in `regenerate`, `resend`, and
`editAndResend`.

- [x] **Step 6: Run focused and static verification**

Run:

```bash
pnpm test src/renderer/ai/scroll-follow.test.ts
pnpm typecheck
pnpm lint
pnpm format:check
```

Expected: all commands exit `0`; the focused test reports 6 passing tests.

- [x] **Step 7: Run the full test suite**

Run:

```bash
pnpm test
```

Expected: all test files pass with no failures.

- [ ] **Step 8: Commit the regression fix**

```bash
git add docs/superpowers/plans/2026-07-13-streaming-scroll-follow.md \
  src/renderer/ai/scroll-follow.ts \
  src/renderer/ai/scroll-follow.test.ts \
  src/renderer/ai/AIPanel.tsx
git commit -m "fix(ai): suspend streaming scroll follow when browsing history"
```
