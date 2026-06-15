---
"marginalia": patch
---

Fix PDF zoom interactions. Pinch and Ctrl+scroll now stay anchored to the cursor (and the toolbar +/− buttons and percentage input to the viewport center) instead of jumping to a different page — including during continuous pinch gestures, which previously drifted unpredictably. Zooming no longer flashes white: pages stay visible by stretching the current frame during the gesture and re-rendering to the new resolution once it settles, swapped in through an offscreen buffer so the canvas is never cleared on screen. Pinch/scroll sensitivity is also increased for a more responsive feel.
