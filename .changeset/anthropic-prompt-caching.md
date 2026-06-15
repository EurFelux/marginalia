---
"marginalia": patch
---

Enable prompt caching for Anthropic (Claude) models, cutting cost and first-token latency on multi-turn conversations. The stable prefix that gets resent every turn — system prompt, tools, and prior messages — is now marked as cacheable (a fixed breakpoint on the system prompt plus rolling breakpoints on the last two turns), so repeated context is billed at the reduced cache-read rate and processed faster instead of re-charged in full each time. Caching is applied through a per-provider strategy layer: Claude (which has no implicit caching) gets explicit cache breakpoints, while OpenAI, Gemini, and OpenAI-compatible providers (e.g. DeepSeek) are passed through untouched since they cache long prefixes automatically server-side.
