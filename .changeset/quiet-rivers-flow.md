---
"marginalia": patch
---

Fix assistant replies stalling while the model calls a tool. With fast models, the reply text could freeze for several seconds and then appear all at once when the tool finished; it now streams smoothly the whole way through.
