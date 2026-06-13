---
"marginalia": patch
---

Fix large position jumps when scrolling up in ePub books. Section iframes now keep their estimated height from the moment they mount (previously they collapsed to the browser default for a few frames while reloading, forcing the reader to compensate mid-scroll), unmeasured sections are estimated from chapter text length instead of a fixed placeholder, and sections above the viewport pre-mount earlier so height corrections happen off-screen.
