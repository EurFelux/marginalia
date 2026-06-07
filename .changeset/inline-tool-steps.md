---
"marginalia": patch
---

Tool-call steps in AI replies now appear inside the assistant bubble, inline with the response text in the order they happened, instead of stacking as separate cards above it. Each step is a compact one-line row with a human-readable description — "Reading page 12" or "Reading “Preface”" rather than raw tool names — and a live status (loading / done / failed). Failed steps are shown honestly in red, so you can see the AI correct itself and retry. Works for past conversations too.
