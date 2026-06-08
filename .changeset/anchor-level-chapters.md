---
"marginalia": minor
---

ePub reader now recognizes chapters anchored within shared spine files (e.g. Calibre/Epubor exports that pack a whole book into one or two HTML files). The table of contents, AI chapter tools, and chapter text all resolve at #fragment-anchor granularity instead of collapsing to per-file chapters. Existing books upgrade automatically on next open.
