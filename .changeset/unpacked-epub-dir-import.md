---
"marginalia": patch
---

Import EPUB books that are unpacked directories instead of zip files (for example, books exported from Apple Books, or epubs unzipped by Calibre/Sigil). These previously failed to import with an `EISDIR` error; they are now packed into a standard EPUB on import. Directories that aren't valid EPUBs, or whose contents can't be read (e.g. not-yet-downloaded iCloud placeholders), now report a clear, actionable error.
