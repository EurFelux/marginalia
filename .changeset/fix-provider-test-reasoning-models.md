---
"marginalia": patch
---

Fix the provider connection test failing for reasoning models (such as Kimi K2.6) with a baffling "failed: HTTP 200" message. The connectivity probe only requested a single output token — far too little for a reasoning model to even begin its internal reasoning — so the provider returned an incomplete HTTP 200 response that surfaced as a self-contradictory failure (a success status code reported as an error). The probe now allows enough output budget for reasoning models, a 2xx response that still can't be parsed now reports an honest diagnostic instead of a bare status code, and the test failure — previously swallowed with nothing written to the logs — is now recorded as a warning.
