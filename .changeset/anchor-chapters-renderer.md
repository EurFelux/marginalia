---
"marginalia": minor
---

ePub reader now navigates at anchor granularity: clicking a chapter or an in-text link scrolls to the exact #fragment anchor, external links open in the system browser, and current-chapter highlight follows the anchor you're reading as you scroll. Reading position is restored to the exact paragraph you left off at — even for books that pack the whole text into one or two large HTML files, where it previously snapped back to the beginning. Also fixes a white screen when clicking in-text hyperlinks (the sandboxed iframe used to navigate itself to an invalid URL).
