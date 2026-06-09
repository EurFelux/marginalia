# marginalia

## 0.10.0

### Minor Changes

- 5eb8751: Add data backup & restore: export your whole library (books, annotations, reading progress, conversations, settings) to a single zip, and restore it on any machine. Restore replaces current data after a confirmation and keeps a pre-restore safety copy, then relaunches. Backups include your provider API keys in plaintext — the export dialog warns you to keep the file private.

### Patch Changes

- 1b51661: Sort the annotations panel by creation time with the newest first, instead of by reading position — so freshly added highlights and notes always appear at the top.

## 0.9.0

### Minor Changes

- 9a3740e: Add reading-time tracking with a dedicated Stats tab: total / today / last-7-days, a daily reading chart, reading streaks, and per-book time ranking. Navigation now uses Apple Books-style top pill tabs (Library / Stats).

### Patch Changes

- Show a pending placeholder in the AI panel while a reply is being submitted, so it's clear your request was sent before the assistant starts streaming.
- c0e2e48: Fix the AI assistant pretending to call reading tools in longer conversations. Past assistant turns now replay their real tool calls and results in history (instead of being flattened to text), so the model keeps actually reading the book instead of imitating a tool-free transcript.

## 0.8.0

### Minor Changes

- 4cbe610: Add a configurable step limit for AI replies (Advanced settings). The default agent step cap is raised from 5 to 10, and you can set any value from 1–99 or choose "Unlimited" — helpful for page-by-page PDF reading where the AI needs more tool-call steps to gather context.
- c0f3eca: Keep long AI conversations focused. Once a conversation's recent history grows past a large budget, older turns are folded in the background into a rolling summary while recent turns stay verbatim, so the prompt sent to the model stays bounded instead of growing without limit. This curbs the cost, latency, and quality drift (the assistant losing focus or skipping tool calls) that long reading sessions used to cause. Existing conversations are unaffected until they cross the threshold, and the summary is derived state only — your message history is never altered.

### Patch Changes

- 3ac5f03: Auto-focus the AI panel input after triggering an AI action (ask/explain/translate/summarize, opening a conversation, or starting a new one), so you can type a follow-up immediately without an extra click.
- 77f49f5: Surface previously-silent failures in the AI streaming pipeline. When the main process couldn't push a stream chunk to the renderer (for example a payload that fails structured clone), the error was swallowed with nothing written to the logs; the chat stream's client-side errors were likewise never recorded. Both paths now emit warnings, and each agent step's finish reason is logged in development. So when an AI reply stalls or a requested tool call doesn't fire, there's a diagnostic trail to follow instead of silence.
- f73fe67: Mark books as finished in your library. Right-click a book and choose "Mark as finished" to flag it as read — a green check badge appears on its cover, and the book drops off the "Continue reading" shelf. Choose "Unmark as finished" to undo. The book's right-click menu now also shows an icon beside each action.
- fd08446: Edit, resend, and regenerate AI chat messages. Hover a message in the AI panel to reveal actions: edit one of your earlier questions and resend it, resend it unchanged, or regenerate the assistant's reply. The conversation is truncated from that point and a fresh reply is streamed — useful for rephrasing, retrying a failed reply, or getting an alternative answer.
- 837f323: Fix the provider connection test failing for reasoning models (such as Kimi K2.6) with a baffling "failed: HTTP 200" message. The connectivity probe only requested a single output token — far too little for a reasoning model to even begin its internal reasoning — so the provider returned an incomplete HTTP 200 response that surfaced as a self-contradictory failure (a success status code reported as an error). The probe now allows enough output budget for reasoning models, a 2xx response that still can't be parsed now reports an honest diagnostic instead of a bare status code, and the test failure — previously swallowed with nothing written to the logs — is now recorded as a warning.
- 1fecb84: Add a copy button to AI chat messages. Hovering (or keyboard-focusing) any message in the AI panel reveals a small toolbar; the copy action places the message's markdown source on the clipboard, so you can paste a reply into notes or feed it back into another prompt. Works for both AI replies and your own messages.

## 0.7.0

### Minor Changes

- 8e8fdbf: ePub reader now navigates at anchor granularity: clicking a chapter or an in-text link scrolls to the exact #fragment anchor, external links open in the system browser, and current-chapter highlight follows the anchor you're reading as you scroll. Reading position is restored to the exact paragraph you left off at — even for books that pack the whole text into one or two large HTML files, where it previously snapped back to the beginning. Also fixes a white screen when clicking in-text hyperlinks (the sandboxed iframe used to navigate itself to an invalid URL).
- 7b11735: ePub reader now recognizes chapters anchored within shared spine files (e.g. Calibre/Epubor exports that pack a whole book into one or two HTML files). The table of contents, AI chapter tools, and chapter text all resolve at #fragment-anchor granularity instead of collapsing to per-file chapters. Existing books upgrade automatically on next open.

## 0.6.0

### Minor Changes

- a3cbff4: Add a hover card that previews a highlight's note in both the ePub and PDF readers. Hover an annotated selection to see its quote and note, move into the card to read long notes, and click Edit to jump straight to the note editor.
- 6be4c93: Remember each book's last-active AI conversation and restore it on reopen, and fix the previous book's conversation lingering in the AI panel after switching books.

### Patch Changes

- 5aeebea: Fix ePub imports being wrongly rejected as "already in your library"

  Some ePubs (notably ones from certain online sources) ship with a non-unique boilerplate identifier, so two completely different books could carry the same `dc:identifier`. Marginalia used that identifier as a book's identity, which made it silently refuse to import the second book as a duplicate. Book identity now derives from the file's content hash — the same approach already used for PDFs — so distinct books always import correctly, while re-importing the exact same file stays de-duplicated.

- 4522516: Respect IME composition when pressing Enter. In the chat composer and the manual model-name input, Enter no longer sends/submits while an East Asian input method (Chinese/Japanese/Korean) is composing — confirming a candidate with Enter now commits the text instead of firing off a half-composed message. Shift+Enter still inserts a newline.
- 8faea92: Stop a book from being dragged while you interact with its dialog in the library

  Opening a book's "Edit info" (or delete confirmation) dialog from the library and then pressing and moving the pointer anywhere inside it would accidentally start dragging and reordering the book underneath. These dialogs render in a portal, so their pointer events still bubbled through React's component tree to the draggable book card. The grid now only begins a drag when the gesture actually starts on the card itself, so you can freely click and drag inside dialogs.

- 2570842: Keep the library header fixed while only the book grid scrolls

  The library view used to scroll as a whole — header included — whenever the window was short or held many books, and the page background could stop short of the scrolled content. The header now stays pinned while only the book grid scrolls inside the same subtle macOS-style overlay scrollbar used elsewhere in the app, and the background always fills the view.

## 0.5.0

### Minor Changes

- d6a5e93: You can now edit a book's title and author right from the library: right-click a book cover and choose "Edit details". This finally gives you a way to clean up messy metadata from repackaged files (site-suffixed titles, garbled authors) or name books that imported without a title — no more deleting and re-importing. Leaving the author field empty shows the book as "Unknown author"; titles can't be empty. Changes show up immediately on the library card and inside the reader.
- 2065af2: Conversations in the sidebar can now be deleted — right-click one or hover and hit the trash icon, then confirm. Deleting the conversation you're currently in clears the AI panel back to a fresh-start state, and if the AI is mid-reply for it, the stream is stopped cleanly. All of the conversation's messages are removed with it.
- d10e0dd: Add a "Continue reading" shelf, manual library ordering, and reading progress display
  - **Continue reading shelf**: the library now shows your 3 most recently read books above the grid, as info cards with cover, title, author, and a reading progress bar. Click a card to jump back in. The shelf hides itself until you've read something.
  - **Drag to reorder**: rearrange books in the library grid by dragging. Your custom order persists; newly imported books land at the front.
  - **Reading progress in the reader**: the header breadcrumb now shows how far you are — a percentage for ePubs, page numbers plus percentage for PDFs (e.g. `12 / 304 · 4%`).

- 24616f3: Marginalia now keeps persistent logs, so problems can be diagnosed after the fact instead of vanishing with the session. Notable events — errors, AI pipeline hiccups, import and migration activity — are written to daily log files (kept for 30 days) under the app's data directory, with main-process and reader-window logs stored in separate files. A new "Advanced" section in Settings provides an "Open logs folder" button so you can grab the files when reporting an issue.

  Crashes and silent failures leave traces too: the reader window now reports script errors and component crashes (showing a friendly reload screen instead of a blank page), and operations that used to fail invisibly — AI tool calls, summary generation, reading-progress saves — are all recorded.

### Patch Changes

- 2eb00ab: Tool-call steps in AI replies now appear inside the assistant bubble, inline with the response text in the order they happened, instead of stacking as separate cards above it. Each step is a compact one-line row with a human-readable description — "Reading page 12" or "Reading “Preface”" rather than raw tool names — and a live status (loading / done / failed). Failed steps are shown honestly in red, so you can see the AI correct itself and retry. Works for past conversations too.

## 0.4.0

### Minor Changes

- 9d9107a: Marginalia now reads PDFs as first-class citizens alongside ePubs. Import them by drag & drop or file picker (untitled files take their name from the file), and read with crisp canvas rendering, smooth zoom (±10% steps from 25% to 500%, with a directly editable percentage that's remembered across restarts), dark-mode inversion, and reading-progress restore. Outlines become the chapter list, the first page becomes the library cover, and scanned PDFs are detected at import — readable as always, with AI text features clearly disabled instead of failing silently.

  Everything you do in ePubs works in PDFs too: select text to ask the AI (surrounding context included) or to create highlights and notes — overlays survive restarts and zoom, click one to recolor, annotate, or delete, and the sidebar lists every annotation with its page for one-click navigation. Links inside PDFs are clickable (both embedded link annotations and plain-text URLs), opening externally in your browser. The AI gains a page-level reading tool — it can read any page by number, look at rendered page images on vision-capable providers, and it now knows where you currently are in the book, so "what am I reading?" just works.

  Typography matches desktop-class PDF viewers: CMap and standard-font data ship with the app so external CJK encodings decode correctly, and fonts that aren't embedded (common in repacked books) render through curated substitution chains — heiti headings stay heiti, songti body text stays songti, and western faces like Times, Garamond, or Palatino map to the closest installed font.

### Patch Changes

- e0ccc92: Settings and all locally stored data (providers, models, annotations, library) now load and save correctly while offline — local database access is no longer paused when the network is down.

## 0.3.0

### Minor Changes

- 5fa6417: The chapter summary pill moves to the reader top bar, and the composer gets a unified context pill row — hover any pill to preview its content, dashed borders mark missing summaries, and the selection context can be removed before sending.
- 32af005: Conversations are no longer tied to chapters — keep one continuous conversation while reading across chapters. Summaries become user-controlled context chips, and conversations get AI-generated titles after the first reply.
- a1eb1bb: Add an independent summary model setting. Chapter summaries, book summaries, and conversation auto-naming now use a separately configured model (Settings → Models → Summary model) instead of sharing the chat model, so you can route background tasks to a faster, cheaper model. The summary model must be configured explicitly — when unset, manual summary generation shows a clear error, and auto-naming is skipped. Also fixes reader layout persistence, which previously never survived restarts.

### Patch Changes

- 2887ba4: Toggling a summary chip now surfaces generation errors (e.g. "Summary model is not configured") as a toast instead of failing silently.

## 0.2.0

### Minor Changes

- 53a7a98: Switch body font in reading preferences: book default, LXGW WenKai (楷体), serif (Fraunces + Noto Serif SC), or sans (Manrope + Noto Sans SC) — CJK fonts bundled, applies to all books

### Patch Changes

- Fix first launch showing a blank window and prompting for keychain access after every update (cookie-encryption fuse retired — the app keeps no cookies and no longer touches the keychain)
- 53a7a98: Fix images sometimes failing to appear on first paint when opening a book
- 53a7a98: Fix macOS Gatekeeper rejecting downloaded builds (ad-hoc code signing)
- 9e2a97b: Fix the collapsed left sidebar's hover drawer having a transparent background (reader text showed through)
- 86264b2: Fix chapter/book summary status getting stuck on "pending" after the summary was generated, and surface a clear error toast (e.g. missing API key) when generating a summary fails instead of silently doing nothing

## 0.1.0

Initial release.
