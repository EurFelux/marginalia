---
"marginalia": patch
---

Fixed the in-book AI assistant reading and summarizing only a sliver of some EPUB chapters. When a chapter's text is split across several internal files (common in many EPUBs), the assistant previously saw just the first fragment — often only the chapter title and opening line — and missed the rest of the body. It now reads the chapter in full.
