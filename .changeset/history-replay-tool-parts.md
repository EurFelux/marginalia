---
"marginalia": patch
---

Fix the AI assistant pretending to call reading tools in longer conversations. Past assistant turns now replay their real tool calls and results in history (instead of being flattened to text), so the model keeps actually reading the book instead of imitating a tool-free transcript.
