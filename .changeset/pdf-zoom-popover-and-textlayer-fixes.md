---
"marginalia": patch
---

PDF reading polish: the zoom control moved out of the page corner into the header preferences popover, so nothing floats over the text anymore. Zoom now steps ±10% across 25%–500%, the percentage can be typed in directly (just like browser PDF viewers), and your zoom level is remembered across restarts. Two visual bugs are fixed as well: text selection now lines up exactly with the words on the page (previously the selectable regions drifted off the actual text, especially in CJK documents), and high zoom levels no longer distort the page aspect ratio — pages keep their proportions and can be scrolled horizontally.

Selection interactions now match ePub: hovering a highlight or an active selection shows a pointer cursor, and clicking inside a selection re-summons its toolbar instead of dismissing it (handy after scrolling hid it). PDF font handling also got its missing pieces — CMap and standard-font data are now bundled, so books that rely on external CJK encodings or non-embedded standard fonts decode and render correctly in both the reader and AI text extraction.

Fonts in PDFs that don't embed their glyphs (common in repacked books) now render with proper system-font substitutes instead of one generic fallback: headings keep their heiti/gothic look, body text stays songti/serif, and western faces like Times, Garamond, or Cambria map to the closest font installed on your machine — closely matching how desktop PDF viewers render the same file.
