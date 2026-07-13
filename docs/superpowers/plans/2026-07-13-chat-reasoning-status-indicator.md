# Chat Reasoning Status Indicator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the ambiguous cursor-only chat placeholder with accurate preparation and reasoning status, while rendering the configured assistant identity immediately after submission.

**Architecture:** Add a renderer-only pure selector that projects AI SDK chat status and the latest assistant parts into `"preparing" | "reasoning" | null`. Reuse one assistant identity shell for submitted placeholders and real assistant messages, and render localized accessible status text after currently visible message segments so post-tool reasoning appears below the completed tool row.

**Tech Stack:** TypeScript 6, React 19 with React Compiler, Vercel AI SDK v7 UI message parts, Tailwind CSS v4, react-i18next, Vitest 4 running in Electron runtime.

## Global Constraints

- Issue: `#101 · Show model reasoning status in the chat UI`.
- Design source: `docs/superpowers/specs/2026-07-13-reasoning-status-indicator-design.md`.
- Scope is interactive chat UI only; do not change chapter-summary or book-summary indicators.
- Do not display, read, copy, summarize, or expand `reasoning.text`.
- Do not change main-process AI orchestration, IPC contracts, preload APIs, persistence, database schema, or migrations.
- Keep the renderer thin: the new helper is presentation-state derivation only.
- Use Tailwind classes; do not add inline styles.
- React Compiler is enabled; do not add `useMemo` or `useCallback`.
- The assistant avatar/name must appear immediately after submit only when the existing avatar preference is enabled.
- An active tool row replaces the standalone activity indicator; later reasoning appears below the completed tool row in the same assistant bubble.
- Decorative dots animate only under `motion-safe`; readable status text remains present without animation.
- Add both English and Simplified Chinese copy.

---

## File Structure

- Create `src/renderer/ai/assistant-activity.ts`: pure activity projection from `ChatStatus` plus assistant parts; never imports React or reads reasoning content.
- Create `src/renderer/ai/assistant-activity.test.ts`: focused precedence and transition-gap tests for the projection.
- Modify `src/index.css`: define the Tailwind animation token and keyframes for staggered thinking dots.
- Modify `src/renderer/ai/MessageList.tsx`: consume the projection, share assistant identity geometry, render accessible status, and remove the cursor placeholder.
- Modify `src/shared/i18n/locales/en.ts`: English preparation and reasoning labels.
- Modify `src/shared/i18n/locales/zh-CN.ts`: Simplified Chinese preparation and reasoning labels.

### Task 1: Derive display-only assistant activity

**Files:**

- Create: `src/renderer/ai/assistant-activity.ts`
- Create: `src/renderer/ai/assistant-activity.test.ts`

**Interfaces:**

- Consumes: `ChatStatus` from `ai` and `ChatUIMessage["parts"]` from `@renderer/ai/types`.
- Produces: `AssistantActivity = "preparing" | "reasoning" | null` and `assistantActivity(status, parts)` for `MessageList`.

- [ ] **Step 1: Write the failing selector tests**

Create `src/renderer/ai/assistant-activity.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { assistantActivity } from "@renderer/ai/assistant-activity";
import type { ChatUIMessage } from "@renderer/ai/types";

type Part = ChatUIMessage["parts"][number];

const reasoning = (state: "streaming" | "done", text = "SECRET_CHAIN_OF_THOUGHT"): Part => ({
  type: "reasoning",
  text,
  state,
});

const text = (value: string): Part => ({ type: "text", text: value });

const tool = (state: "input-available" | "output-available"): Part =>
  ({
    type: "tool-readPage",
    toolCallId: "call-1",
    state,
    input: { page: 1 },
    ...(state === "output-available"
      ? { output: { kind: "text", page: 1, text: "page contents" } }
      : {}),
  }) as Part;

const stepStart = { type: "step-start" } as Part;

describe("assistantActivity", () => {
  it("shows preparing immediately after submission", () => {
    expect(assistantActivity("submitted", undefined)).toBe("preparing");
  });

  it("shows preparing for structural-only streaming", () => {
    expect(assistantActivity("streaming", [stepStart, text("")])).toBe("preparing");
  });

  it("shows reasoning for streaming and completed reasoning parts", () => {
    expect(assistantActivity("streaming", [reasoning("streaming")])).toBe("reasoning");
    expect(assistantActivity("streaming", [reasoning("done")])).toBe("reasoning");
  });

  it("does not derive anything from reasoning text", () => {
    expect(assistantActivity("streaming", [reasoning("streaming", "first secret")])).toBe(
      assistantActivity("streaming", [reasoning("streaming", "different secret")]),
    );
  });

  it("lets a later tool row take over", () => {
    expect(assistantActivity("streaming", [reasoning("done"), tool("input-available")])).toBe(null);
  });

  it("shows later reasoning below a completed tool row", () => {
    expect(
      assistantActivity("streaming", [
        reasoning("done"),
        tool("output-available"),
        reasoning("streaming"),
      ]),
    ).toBe("reasoning");
  });

  it("lets answer text take over", () => {
    expect(assistantActivity("streaming", [reasoning("done"), text("Answer")])).toBe(null);
  });

  it.each(["ready", "error"] as const)("hides activity when chat is %s", (status) => {
    expect(assistantActivity(status, [reasoning("streaming")])).toBe(null);
  });
});
```

- [ ] **Step 2: Run the focused test and verify it fails**

Run:

```bash
pnpm test src/renderer/ai/assistant-activity.test.ts
```

Expected: FAIL because `@renderer/ai/assistant-activity` does not exist.

- [ ] **Step 3: Implement the minimal pure selector**

Create `src/renderer/ai/assistant-activity.ts`:

```ts
import { isToolUIPart, type ChatStatus } from "ai";
import type { ChatUIMessage } from "@renderer/ai/types";

export type AssistantActivity = "preparing" | "reasoning" | null;

/**
 * Display-only projection for the standalone assistant activity indicator.
 * Reasoning content is deliberately never inspected; only part type/order matters.
 */
export function assistantActivity(
  status: ChatStatus,
  parts: ChatUIMessage["parts"] | undefined,
): AssistantActivity {
  if (status === "submitted") return "preparing";
  if (status !== "streaming") return null;

  for (let index = (parts?.length ?? 0) - 1; index >= 0; index -= 1) {
    const part = parts?.[index];
    if (!part) continue;
    if (part.type === "reasoning") return "reasoning";
    if (part.type === "text") {
      if (part.text.length > 0) return null;
      continue;
    }
    if (isToolUIPart(part)) return null;
  }

  return "preparing";
}
```

This reverse scan defines the visible precedence without reading `reasoning.text`: the latest meaningful reasoning part shows the indicator, while later text or a later tool part takes over. A later reasoning part after a completed tool restores the indicator.

- [ ] **Step 4: Run the focused test and verify it passes**

Run:

```bash
pnpm test src/renderer/ai/assistant-activity.test.ts
```

Expected: PASS with 9 tests.

- [ ] **Step 5: Run static checks for the new helper**

Run:

```bash
pnpm typecheck
pnpm lint
```

Expected: both commands exit 0 with no TypeScript or lint errors.

- [ ] **Step 6: Commit the independently tested selector**

```bash
git add src/renderer/ai/assistant-activity.ts src/renderer/ai/assistant-activity.test.ts
git commit -m "feat(ai): derive assistant activity from stream parts (#101)"
```

### Task 2: Render shared assistant identity and localized status

**Files:**

- Modify: `src/index.css`
- Modify: `src/renderer/ai/MessageList.tsx:1-210`
- Modify: `src/shared/i18n/locales/en.ts:1-60`
- Modify: `src/shared/i18n/locales/zh-CN.ts:1-60`

**Interfaces:**

- Consumes: `assistantActivity(status, parts)` and `AssistantActivity` from Task 1; existing `showAgentAvatar`, assistant name, `segments()`, and tool rows.
- Produces: an immediate submitted assistant shell, phase-specific live status, and stable post-tool placement within the real assistant bubble.

- [ ] **Step 1: Add localized activity copy**

Insert these keys with the other alphabetically ordered `ai.*` keys in `src/shared/i18n/locales/en.ts`:

```ts
  "ai.activity.preparing": "Preparing a response…",
  "ai.activity.reasoning": "Thinking…",
```

Insert the matching keys in `src/shared/i18n/locales/zh-CN.ts`:

```ts
  "ai.activity.preparing": "正在准备回答…",
  "ai.activity.reasoning": "正在思考…",
```

- [ ] **Step 2: Import the shared types and activity selector**

Replace the first React import and add the activity import in `src/renderer/ai/MessageList.tsx`:

```ts
import { useState, type ReactNode } from "react";
import type { ChatStatus } from "ai";
import { getToolName } from "ai";
// existing imports remain
import { assistantActivity, type AssistantActivity } from "@renderer/ai/assistant-activity";
```

- [ ] **Step 3: Derive one activity value for the live tail message**

Replace the existing `lastId` declaration with:

```ts
const lastMessage = messages.at(-1);
const lastId = lastMessage?.id;
const activity = assistantActivity(
  status,
  lastMessage?.role === "assistant" ? lastMessage.parts : undefined,
);
```

Pass it only to the live assistant tail:

```tsx
<AssistantBubble
  key={m.id}
  m={m}
  streaming={status === "streaming" && m.id === lastId}
  activity={m.id === lastId ? activity : null}
  chapters={chapters}
  showAvatar={showAvatar}
  agentName={agentName}
  groupHead={i === 0 || messages[i - 1].role !== "assistant"}
/>
```

Replace the submitted placeholder mount with the identity-aware version:

```tsx
{
  status === "submitted" && <PendingBubble showAvatar={showAvatar} agentName={agentName} />;
}
```

- [ ] **Step 4: Replace the cursor placeholder with the accessible activity indicator**

Add the animation token inside the existing `@theme inline` block in `src/index.css`, followed by the keyframes:

```css
--animate-thinking-dot: thinking-dot 1.2s ease-in-out infinite;
--animate-thinking-dot-delay-150: thinking-dot 1.2s ease-in-out 150ms infinite;
--animate-thinking-dot-delay-300: thinking-dot 1.2s ease-in-out 300ms infinite;

@keyframes thinking-dot {
  0%,
  70%,
  100% {
    opacity: 0.28;
    transform: scale(0.82);
  }
  35% {
    opacity: 1;
    transform: scale(1);
  }
}
```

Delete `ThinkingCursor` and replace `PendingBubble` with these components:

```tsx
function AssistantActivityIndicator({ activity }: { activity: Exclude<AssistantActivity, null> }) {
  const { t } = useTranslation();
  const label =
    activity === "preparing"
      ? t("ai.activity.preparing", "正在准备回答…")
      : t("ai.activity.reasoning", "正在思考…");

  return (
    <div
      className="flex items-center gap-2 text-xs text-muted-foreground"
      role="status"
      aria-live="polite"
    >
      <span className="inline-flex gap-1" aria-hidden="true">
        <span className="size-1.5 rounded-full bg-primary/80 motion-safe:animate-thinking-dot" />
        <span className="size-1.5 rounded-full bg-primary/80 motion-safe:animate-thinking-dot-delay-150" />
        <span className="size-1.5 rounded-full bg-primary/80 motion-safe:animate-thinking-dot-delay-300" />
      </span>
      <span>{label}</span>
    </div>
  );
}

function PendingBubble({ showAvatar, agentName }: { showAvatar: boolean; agentName: string }) {
  return (
    <AssistantShell showAvatar={showAvatar} agentName={agentName} groupHead>
      <div className="max-w-full space-y-2 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground">
        <AssistantActivityIndicator activity="preparing" />
      </div>
    </AssistantShell>
  );
}
```

Each dot runs the same opacity-and-scale breath with 150 ms phase offsets, producing a left-to-right flow. The 150 ms and 300 ms delays live inside dedicated animation-token shorthands instead of separate arbitrary `animation-delay` utilities, preventing a later generated `animation` shorthand from resetting both delays to zero. The `motion-safe:animate-thinking-dot*` utilities run only when the operating-system reduced-motion preference is not enabled; otherwise all three dots remain static. The readable label remains unchanged in either mode.

- [ ] **Step 5: Extract the shared assistant identity shell**

Add this component immediately before `AssistantBubble`:

```tsx
function AssistantShell({
  children,
  showAvatar,
  agentName,
  groupHead,
  messageId,
}: {
  children: ReactNode;
  showAvatar: boolean;
  agentName: string;
  groupHead: boolean;
  messageId?: string;
}) {
  const body = (
    <div className="group flex flex-col items-start" data-message-id={messageId}>
      {showAvatar && groupHead && (
        <span className="mb-1 text-xs font-medium text-muted-foreground">{agentName}</span>
      )}
      {children}
    </div>
  );

  if (!showAvatar) {
    return (
      <div className="max-w-[88%]" data-message-id={messageId}>
        {body}
      </div>
    );
  }

  return (
    <div className="flex max-w-[92%] items-start gap-2" data-message-id={messageId}>
      <div className="w-7 shrink-0">{groupHead && <AssistantAvatar className="size-7" />}</div>
      <div className="min-w-0 flex-1">{body}</div>
    </div>
  );
}
```

This preserves the current avatar-enabled and avatar-disabled widths. The pending shell passes `groupHead`, so identity appears immediately after the user message when enabled.

- [ ] **Step 6: Render activity after visible assistant segments**

Add `activity` to the `AssistantBubble` parameters and props:

```ts
  activity,
  // existing props
}: {
  m: ChatUIMessage;
  streaming: boolean;
  activity: AssistantActivity;
  chapters: ChapterRefDto[];
  showAvatar: boolean;
  agentName: string;
  groupHead: boolean;
}) {
```

Replace the current `bubble` variable plus the avatar/no-avatar return branches with:

```tsx
return (
  <AssistantShell
    showAvatar={showAvatar}
    agentName={agentName}
    groupHead={groupHead}
    messageId={m.id}
  >
    <div className="max-w-full space-y-2 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground">
      {segs.map((s, i) =>
        s.kind === "text" ? (
          <LocalizedStreamdown key={i}>{s.text}</LocalizedStreamdown>
        ) : (
          <ToolStepRow key={i} part={s.part} chapters={chapters} />
        ),
      )}
      {activity && <AssistantActivityIndicator activity={activity} />}
    </div>
    {!streaming && <MessageToolbar m={m} />}
  </AssistantShell>
);
```

Keep the existing guard immediately above this return:

```ts
const segs = segments(m.parts);
if (segs.length === 0 && !streaming) return null;
```

Delete the now-unused `hasText` declaration. Because the activity indicator is rendered after `segs`, a later reasoning part after a completed tool produces `completed tool row → Thinking…` in the same bubble. When later answer text arrives, Task 1 returns `null`, leaving the answer below the completed tool row without duplicating identity.

- [ ] **Step 7: Run focused and static verification**

Run:

```bash
pnpm test src/renderer/ai/assistant-activity.test.ts
pnpm typecheck
pnpm lint
pnpm i18n:lint
pnpm format:check
```

Expected: every command exits 0; the focused test reports 9 passing tests; i18n reports no missing keys.

- [ ] **Step 8: Perform Electron UI smoke verification**

Run:

```bash
pnpm start
```

Verify in the running app, then stop it with `Ctrl-C`:

1. Enable the assistant avatar and choose a reasoning-capable chat model with reasoning effort `high`.
2. Send a direct question. Confirm the avatar and name appear immediately with “Preparing a response…”, then the same bubble shows “Thinking…”, then answer text replaces the status.
3. Ask a book-context question that requires reading a chapter or page. Confirm the active tool row replaces the thinking status; after the tool completes, later “Thinking…” appears directly below the completed tool row; answer text then appears below that row in the same bubble.
4. Disable the assistant avatar and send again. Confirm the status bubble remains but avatar and name are absent.
5. Stop one request and provoke one provider error. Confirm neither path leaves a stale preparation or reasoning indicator.
6. Enable the operating-system reduced-motion preference. Confirm the dots become static while the full status label remains visible.

- [ ] **Step 9: Commit the UI integration**

```bash
git add src/renderer/ai/MessageList.tsx src/shared/i18n/locales/en.ts src/shared/i18n/locales/zh-CN.ts
git commit -m "feat(ai): show preparation and reasoning status (#101)"
```

After Task 2 passes review, use the repository branch-finishing workflow to add the required user-facing changeset and prepare delivery. The delivery commit must include `closes #101`; only then move the kanban card through review to Done.
