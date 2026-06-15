---
"marginalia": patch
---

Fix epub highlights showing no chapter in single-file books where every chapter shares one spine file (table of contents split by anchors). Annotation chapter lookup now subdivides such a shared file to the correct anchor chapter using boundary CFIs precomputed when the book opens. Multi-file books are unaffected.
