---
"marginalia": patch
---

Fix reading reports that saved the assistant's closing remark ("The report is written…") instead of the report itself. The assistant now hands in the finished report explicitly, and only that report is saved; if it never does, generation fails and your previous report is kept rather than being replaced by stray text. Memories noted while writing the report are still saved together with it. If one of your reports shows such a closing line, regenerate it.
