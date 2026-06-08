---
"marginalia": patch
---

Fix ePub imports being wrongly rejected as "already in your library"

Some ePubs (notably ones from certain online sources) ship with a non-unique boilerplate identifier, so two completely different books could carry the same `dc:identifier`. Marginalia used that identifier as a book's identity, which made it silently refuse to import the second book as a duplicate. Book identity now derives from the file's content hash — the same approach already used for PDFs — so distinct books always import correctly, while re-importing the exact same file stays de-duplicated.
