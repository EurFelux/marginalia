---
"marginalia": minor
---

Give the AI companion awareness of the current date and time. Each turn now injects the wall-clock time (in your local timezone, ISO 8601 with offset) into the live message sent to the model, so it can answer time-relative questions ("how recent is this", "what year is it now") and reason about recency instead of guessing. The timestamp rides along only on the current turn — it never enters the cached system prefix and is never persisted, so it stays accurate every turn without disturbing prompt caching.
