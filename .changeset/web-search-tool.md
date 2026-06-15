---
"marginalia": minor
---

Add an AI web search tool. Toggle the "联网" (web) pill in the AI panel's context row and the assistant can search the web (powered by Exa) for current or external information beyond the book — the search shows up as a step in the reply and sources are linked inline. Works out of the box: Exa's free tier needs no API key, so the toggle is ready to use immediately; add an optional Exa API key under Settings → Web search for higher rate limits. Search is off per message by default (only the message you toggle searches), and backends are pluggable with automatic fallback so you can point it at another MCP search server.
