# marginalia

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
