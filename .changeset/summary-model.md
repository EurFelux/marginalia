---
"marginalia": minor
---

Add an independent summary model setting. Chapter summaries, book summaries, and conversation auto-naming now use a separately configured model (Settings → Models → Summary model) instead of sharing the chat model, so you can route background tasks to a faster, cheaper model. The summary model must be configured explicitly — when unset, manual summary generation shows a clear error, and auto-naming is skipped. Also fixes reader layout persistence, which previously never survived restarts.
