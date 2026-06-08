---
"marginalia": patch
---

Keep the library header fixed while only the book grid scrolls

The library view used to scroll as a whole — header included — whenever the window was short or held many books, and the page background could stop short of the scrolled content. The header now stays pinned while only the book grid scrolls inside the same subtle macOS-style overlay scrollbar used elsewhere in the app, and the background always fills the view.
