---
"marginalia": patch
---

Stop a book from being dragged while you interact with its dialog in the library

Opening a book's "Edit info" (or delete confirmation) dialog from the library and then pressing and moving the pointer anywhere inside it would accidentally start dragging and reordering the book underneath. These dialogs render in a portal, so their pointer events still bubbled through React's component tree to the draggable book card. The grid now only begins a drag when the gesture actually starts on the card itself, so you can freely click and drag inside dialogs.
