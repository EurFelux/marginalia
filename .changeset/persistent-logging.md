---
"marginalia": minor
---

Marginalia now keeps persistent logs, so problems can be diagnosed after the fact instead of vanishing with the session. Notable events — errors, AI pipeline hiccups, import and migration activity — are written to daily log files (kept for 30 days) under the app's data directory, with main-process and reader-window logs stored in separate files. A new "Advanced" section in Settings provides an "Open logs folder" button so you can grab the files when reporting an issue.

Crashes and silent failures leave traces too: the reader window now reports script errors and component crashes (showing a friendly reload screen instead of a blank page), and operations that used to fail invisibly — AI tool calls, summary generation, reading-progress saves — are all recorded.
