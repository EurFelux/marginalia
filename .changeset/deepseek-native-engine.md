---
"marginalia": patch
---

The built-in DeepSeek provider now speaks its native chat API via the official `@ai-sdk/deepseek` package: thinking streams and prompt-cache stats are handled natively, and a server-side resource interruption (`insufficient_system_resource`) is now surfaced as an error you can retry instead of silently looking like a finished reply. You can also switch DeepSeek to the OpenAI Responses API in Settings — three API formats (Chat Completions / Responses / Anthropic) are now selectable.
