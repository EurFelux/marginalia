---
"marginalia": minor
---

Marginalia now reads PDFs as first-class citizens alongside ePubs. Import them by drag & drop or file picker (untitled files take their name from the file), and read with crisp canvas rendering, smooth zoom (±10% steps from 25% to 500%, with a directly editable percentage that's remembered across restarts), dark-mode inversion, and reading-progress restore. Outlines become the chapter list, the first page becomes the library cover, and scanned PDFs are detected at import — readable as always, with AI text features clearly disabled instead of failing silently.

Everything you do in ePubs works in PDFs too: select text to ask the AI (surrounding context included) or to create highlights and notes — overlays survive restarts and zoom, click one to recolor, annotate, or delete, and the sidebar lists every annotation with its page for one-click navigation. Links inside PDFs are clickable (both embedded link annotations and plain-text URLs), opening externally in your browser. The AI gains a page-level reading tool — it can read any page by number, look at rendered page images on vision-capable providers, and it now knows where you currently are in the book, so "what am I reading?" just works.

Typography matches desktop-class PDF viewers: CMap and standard-font data ship with the app so external CJK encodings decode correctly, and fonts that aren't embedded (common in repacked books) render through curated substitution chains — heiti headings stay heiti, songti body text stays songti, and western faces like Times, Garamond, or Palatino map to the closest installed font.
