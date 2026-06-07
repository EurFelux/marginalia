# marginalia

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
