---
"marginalia": minor
---

Keep long AI conversations focused. Once a conversation's recent history grows past a large budget, older turns are folded in the background into a rolling summary while recent turns stay verbatim, so the prompt sent to the model stays bounded instead of growing without limit. This curbs the cost, latency, and quality drift (the assistant losing focus or skipping tool calls) that long reading sessions used to cause. Existing conversations are unaffected until they cross the threshold, and the summary is derived state only — your message history is never altered.
