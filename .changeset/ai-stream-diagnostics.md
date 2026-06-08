---
"marginalia": patch
---

Surface previously-silent failures in the AI streaming pipeline. When the main process couldn't push a stream chunk to the renderer (for example a payload that fails structured clone), the error was swallowed with nothing written to the logs; the chat stream's client-side errors were likewise never recorded. Both paths now emit warnings, and each agent step's finish reason is logged in development. So when an AI reply stalls or a requested tool call doesn't fire, there's a diagnostic trail to follow instead of silence.
