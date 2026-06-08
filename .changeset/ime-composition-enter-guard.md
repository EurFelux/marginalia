---
"marginalia": patch
---

Respect IME composition when pressing Enter. In the chat composer and the manual model-name input, Enter no longer sends/submits while an East Asian input method (Chinese/Japanese/Korean) is composing — confirming a candidate with Enter now commits the text instead of firing off a half-composed message. Shift+Enter still inserts a newline.
