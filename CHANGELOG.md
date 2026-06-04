# marginalia

## 0.2.0

### Minor Changes

- 53a7a98: Switch body font in reading preferences: book default, LXGW WenKai (楷体), serif (Fraunces + Noto Serif SC), or sans (Manrope + Noto Sans SC) — CJK fonts bundled, applies to all books

### Patch Changes

- 53a7a98: Fix images sometimes failing to appear on first paint when opening a book
- 53a7a98: Fix macOS Gatekeeper rejecting downloaded builds (ad-hoc code signing)
- 9e2a97b: Fix the collapsed left sidebar's hover drawer having a transparent background (reader text showed through)
- 86264b2: Fix chapter/book summary status getting stuck on "pending" after the summary was generated, and surface a clear error toast (e.g. missing API key) when generating a summary fails instead of silently doing nothing

## 0.1.0

Initial release.
