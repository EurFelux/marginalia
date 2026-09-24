---
"marginalia": patch
---

Chat replies now tell you when they end abnormally. A reply cut off by the model's output limit, stopped by a content filter, or aborted by the provider shows an error banner instead of silently looking finished; the text received so far is kept. A reply where the AI mistyped a tool call but recovered on its own is no longer marked as failed, and a tool step the model never got to run shows "Not run" instead of loading forever.
