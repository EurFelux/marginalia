# Root Generated Artifacts Gitignore Design

## Goal

Keep renderer build output and the repository-local pnpm store out of Git status without affecting similarly named directories inside workspace packages.

## Design

Add two root-anchored entries to the repository `.gitignore`:

```gitignore
/dist/
/.pnpm-store/
```

Root anchoring is intentional. It ignores the renderer build output and local package store created at the repository root while preserving control over nested `dist` or `.pnpm-store` directories. The existing `packages/*/dist/` rule continues to cover package build output explicitly.

## Verification

Use `git check-ignore -v dist/ .pnpm-store/` to confirm both root directories resolve to the new rules, then confirm `git status --short` no longer lists them.
