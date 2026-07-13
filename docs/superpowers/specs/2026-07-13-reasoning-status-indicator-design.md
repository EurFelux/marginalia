# Marginalia · Chat reasoning status indicator design

> Status: confirmed by the user on 2026-07-13
> Issue: [#101 · Show model reasoning status in the chat UI](https://github.com/EurFelux/marginalia/issues/101)
> Scope: interactive chat UI only

## 1. Problem

Marginalia now lets users configure model reasoning effort, but the chat UI still represents all pre-answer work with an ambiguous pulsing cursor. During the `submitted` interval, the placeholder also omits the assistant avatar and name even when avatar display is enabled. Users therefore cannot tell whether the request is being prepared, the model is reasoning, or the UI is stalled, and the assistant identity appears late.

The AI SDK v7 stream already carries `reasoning-start`, `reasoning-delta`, and `reasoning-end` chunks through the existing IPC transport. `useChat` assembles those chunks into assistant `reasoning` parts with `state: "streaming" | "done"`. `MessageList` currently filters reasoning parts from visible segments, so the necessary phase signal exists without requiring a new main-process or IPC contract.

## 2. Goals and non-goals

### Goals

- Show an immediate, localized `preparing` state after submission and before a meaningful assistant stream part arrives.
- Show a distinct, localized `reasoning` state while a reasoning-capable model is reasoning.
- Preserve the existing visible tool-step states during tool execution.
- Transition cleanly among preparation, reasoning, tools, answer streaming, completion, error, and cancellation.
- Render the configured assistant avatar and name immediately after submission when avatar display is enabled.
- Keep the indicator accessible even when animation is unavailable or reduced.

### Non-goals

- Displaying, summarizing, copying, or expanding chain-of-thought content.
- Adding elapsed-time counters, reasoning summaries, or a new preference.
- Changing the main-process stream, IPC contracts, or persisted message format.
- Changing background chapter-summary or book-summary indicators.

## 3. Chosen approach

Derive a small display-only activity state from the existing `ChatStatus` and the last assistant message's part types and states. Do not introduce a parallel transport-level state machine.

The alternatives were rejected for this scope:

- A renderer transport reducer would duplicate AI SDK message assembly and add synchronization between transport and components.
- Sanitized custom status events from the main process would provide stronger transport isolation but require unnecessary protocol, main-process, and test changes for a presentation-only feature.

The activity selector must inspect only part type, order, tool state, and reasoning state. It must never read the `text` property of a reasoning part.

## 4. User experience

Use the existing assistant visual language rather than a separate loading widget. The pending and reasoning states share the same assistant identity layout and muted bubble shell as a normal assistant response.

When avatar display is enabled, the shell contains:

- the assistant avatar in the existing avatar column;
- the assistant name above the bubble;
- an animated-dot motif and localized status text inside the bubble.

When avatar display is disabled, the shell follows the current anonymous assistant-bubble layout. The status feature does not override that preference.

The approved phase copy is:

- `preparing`: “正在准备回答…” / “Preparing a response…”
- `reasoning`: “正在思考…” / “Thinking…”

The dots are decorative. The text is the complete status signal and remains visible without motion.

## 5. Activity state derivation

Expose a pure selector with this output:

```ts
type AssistantActivity = "preparing" | "reasoning" | null;
```

Apply these rules in order:

1. If chat status is `submitted`, return `preparing`.
2. If chat status is not `streaming`, return `null`.
3. Examine the last assistant message only. If it has visible answer text, return `null`.
4. If its latest active visible operation is a tool part, return `null`; the existing tool row communicates the activity.
5. If it contains a reasoning part and no later answer text or active tool has taken over, return `reasoning`. A completed reasoning part remains the displayed phase during the short gap before the next meaningful part, preventing a flicker back to `preparing` or an empty bubble.
6. If streaming has begun but only structural chunks are present, return `preparing`.

The selector receives no reasoning text and produces no content derived from reasoning text.

## 6. Multi-step flow

A direct answer follows:

```text
submitted: preparing → reasoning: thinking → text: answer streaming → ready
```

A tool-assisted answer may follow:

```text
preparing → thinking → tool row: reading → completed tool row + thinking below it → answer below the completed tool row
```

Each later reasoning phase can show the reasoning indicator again. When reasoning resumes after a tool call, keep the completed tool row in place and render the reasoning indicator immediately below it inside the same assistant bubble. When answer text starts, replace that indicator with the answer below the completed tool row. Do not create another assistant bubble or repeat the avatar and name. The indicator is not permanently latched after the first reasoning event and is not shown simultaneously with an active tool row.

Providers that do not emit reasoning parts follow:

```text
preparing → answer streaming
```

The UI therefore does not claim that a non-reasoning request is reasoning.

## 7. Component boundaries

### Activity selector

A renderer-only pure helper derives `AssistantActivity`. Keeping it outside React makes phase precedence and edge cases directly testable.

### Assistant identity shell

Extract the current assistant avatar/name/content geometry into a shared presentation boundary used by both the submitted placeholder and real assistant messages. It accepts rendered bubble content and identity/grouping inputs; it does not own chat state.

For a submitted placeholder, the shell is always the head of a new assistant group because it follows a user message. When the real assistant message arrives, it uses the same geometry, so the identity and bubble remain visually stable even though the underlying React node changes.

### Activity indicator

A small renderer component maps `AssistantActivity` to localized copy and decorative dots. It renders no reasoning part or reasoning text. Within a real assistant message, place it after all currently visible segments so a post-tool reasoning phase appears directly below the completed tool row. The dots share one semantic color and run the same 1.2-second ease-in-out opacity-and-scale breath with 0 ms, 150 ms, and 300 ms phase offsets, producing a left-to-right flow rather than a synchronized pulse.

### Existing message rendering

`segments()` continues to omit reasoning parts from visible message content. Text rendering, tool rows, message toolbars, and persisted history remain unchanged.

## 8. Accessibility and localization

- Put the readable status in a container with `role="status"` and `aria-live="polite"`.
- Mark decorative dots `aria-hidden="true"`.
- Apply the per-dot animation through Tailwind's `motion-safe` variant. Under Reduced Motion the three dots remain static and the readable status text remains unchanged, so status meaning never depends on animation.
- Add English and Simplified Chinese locale keys and validate them with the repository i18n checks.
- Do not repeatedly announce reasoning deltas. The live-region text changes only when the phase changes.

## 9. Completion, cancellation, and errors

`ready`, `error`, and cancellation states all derive `null`, so no activity indicator can remain after the turn ends. Existing error presentation remains responsible for explaining failures. The reasoning bubble does not introduce a second error message or retain a stale “Thinking…” label.

If a provider emits malformed or incomplete reasoning sequencing, the selector relies on the assembled message state and chat terminal status. It does not attempt to repair the stream protocol.

## 10. Testing and verification

Add focused unit tests for the pure selector:

- `submitted` returns `preparing`;
- a streaming reasoning part returns `reasoning` regardless of its text;
- a completed reasoning part with no later meaningful part remains `reasoning` during the transition gap;
- an active later tool suppresses the standalone indicator;
- a later text part suppresses the indicator;
- structural-only streaming returns `preparing`;
- `ready` and `error` return `null`;
- reasoning content changes do not change the derived result.

Manual Electron verification covers geometry and transitions:

- avatar and name appear immediately on submit when enabled;
- the no-avatar preference remains respected;
- the bubble changes from preparation to reasoning to answer without duplicate identity rows or obvious layout jumps;
- tool-assisted, non-reasoning, cancellation, and error flows leave no stale indicator;
- reduced-motion mode retains readable status text.

Run the proportional repository checks: the focused unit test, `pnpm typecheck`, `pnpm lint`, and `pnpm i18n:lint`.

## 11. Expected change surface

- `src/renderer/ai/MessageList.tsx`: shared assistant shell and activity rendering.
- `src/index.css`: Tailwind animation theme token and keyframes for the staggered thinking dots.
- A small renderer helper and focused test for activity derivation, colocated under `src/renderer/ai/`.
- `src/shared/i18n/locales/en.ts` and `src/shared/i18n/locales/zh-CN.ts`: activity labels.

No shared IPC schema, preload API, main-process AI orchestration, database schema, or migration changes are expected.
