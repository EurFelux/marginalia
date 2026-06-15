---
"marginalia": patch
---

Fix epub highlights showing the wrong chapter (or none) in the annotations sidebar. Chapter lookup matched a CFI's spine position against the TOC-based order index — two different numbering bases — so any book with a cover or front-matter page before its chapters was mislabeled. Annotations now resolve their chapter from the spine href, the same way current-chapter tracking already does.
