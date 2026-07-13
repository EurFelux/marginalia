# Streaming Chat Scroll Follow Design

**Date:** 2026-07-13

## Problem

`AIPanel` originally called `scrollTo()` for every streamed assistant-message update. Because each
chunk replaces the `messages` value while the chat remains in `streaming` status, the panel started a
new smooth scroll on every chunk. Gating those calls on bottom position stopped the panel from
reclaiming an intentionally scrolled-away viewport, but exposed a second problem: the intermediate
frames of an allowed smooth scroll report a non-bottom position and immediately suspend the follow
state again.

The existing behavior of positioning a newly opened conversation or a newly submitted turn at the
bottom must remain.

## Desired Behavior

- Opening a conversation positions its latest messages at the bottom as before.
- Sending a new user message opts the panel into following the new turn from the bottom.
- While streaming, new chunks scroll to the bottom only while the viewport is already at the bottom.
- Any user scroll away from the bottom suspends following immediately.
- Following resumes only after the user scrolls all the way back to the bottom. A four-pixel tolerance
  is allowed solely for fractional DOM measurements and zoom/rounding effects; being merely near the
  bottom does not count.
- Automatic bottom following never uses smooth scrolling. Its intermediate animation frames must not
  participate in follow-state detection.
- Loading older messages continues to preserve its existing visible-message anchor and never enables
  bottom following accidentally.

## Design

Keep the follow state local to `AIPanel` in a ref so scroll events and high-frequency chunks do not
cause React renders. A passive listener on the actual `ScrollArea` viewport updates that ref from
`scrollHeight - scrollTop - clientHeight`.

The message-update effect retains its current distinctions between initial load, history prepend,
new message append, and streaming growth. Every incremental bottom scroll, including the first
assistant chunk arriving as a newly appended message, requires the follow ref to be enabled. Sending
a message explicitly enables following before handing the turn to `useChat`; opening a conversation
keeps its dedicated instant bottom positioning. If the user scrolls away after sending but before the
first assistant chunk, that chunk therefore respects the suspended state.

Every automatic message-update scroll uses `behavior: "instant"`. Streaming already arrives in small,
frequent increments, so the content continues to advance naturally without a competing scroll
animation. Smooth scrolling is reserved for a future explicit, one-shot navigation action such as a
“jump to latest” button; no current automatic path uses it.

Bottom detection and the message-update decision will be small pure functions in the renderer AI
module. This keeps the DOM effect thin and makes the regression behavior testable without mounting
the full chat panel.

No wheel, touch, or pointer-specific detection is needed: viewport position is the source of truth,
so mouse wheels, trackpads, keyboard scrolling, scrollbar dragging, and accessibility-driven scrolls
receive the same behavior.

## Testing

Unit tests will cover:

1. A streaming chunk follows while the viewport is at the bottom.
2. A streaming chunk does not follow after the viewport leaves the bottom.
3. A position within the four-pixel measurement tolerance counts as the bottom, while a position just
   outside it does not.
4. Reaching the bottom resumes following for the next chunk.
5. Prepending older history still never requests a bottom scroll.
6. Every allowed automatic message update requests `instant`, never `smooth`, scrolling.

Verification will run the focused regression test, renderer type checking, linting, formatting checks,
and the full test suite.

## Out of Scope

- A floating “jump to latest” button.
- Changing the visual scrollbar or message rendering.
- Altering conversation pagination or stream transport behavior.
