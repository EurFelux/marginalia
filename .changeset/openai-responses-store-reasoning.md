---
"marginalia": patch
---

Fix AI chat failing partway through a tool-calling turn when using an OpenAI Responses–API provider (notably third-party gateways) with a reasoning model. The request used to error with "Item … not found. Items are not persisted when `store` is set to false." Reasoning is now sent inline instead of as a server-side id reference, so tool-calling conversations complete on stateless endpoints. Also fixed the send-failure hint that always told you to configure an "Anthropic" API key regardless of the provider you'd set up — it now refers to your API key and model generically.
