# Markdown Math Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render inline `$...$` and display `$$...$$` LaTeX formulas in every Markdown surface backed by `LocalizedStreamdown`.

**Architecture:** Install Streamdown's official math plugin and configure it once at module scope in the shared renderer wrapper. Load KaTeX and plugin styles globally so existing AI messages, summaries, and notes gain math rendering without caller changes.

**Tech Stack:** React 19, Streamdown 2.5, `@streamdown/math` 1.0, KaTeX, Vitest 4, Tailwind CSS 4

## Global Constraints

- Support `$...$` for inline formulas.
- Support `$$...$$` on separate lines for display formulas.
- Keep all Markdown consumers on the existing `LocalizedStreamdown` boundary.
- Preserve caller-supplied Streamdown plugins.
- Use the official plugin; do not assemble or preprocess a separate Remark/Rehype pipeline.

---

### Task 1: Enable Math in the Shared Markdown Renderer

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `src/renderer/components/LocalizedStreamdown.test.ts`
- Modify: `src/renderer/components/LocalizedStreamdown.tsx`
- Modify: `src/index.css`
- Create: `.changeset/markdown-math-rendering.md`

**Interfaces:**

- Consumes: `createMathPlugin(options)` from `@streamdown/math` and the existing `StreamdownProps.plugins` object.
- Produces: `LocalizedStreamdown(props: StreamdownProps)`, with math enabled by default and caller plugin entries retained.

- [ ] **Step 1: Write the failing renderer regression test**

Add server-rendering imports and mock `useTranslation` so the existing component can be rendered without a browser or i18n provider:

```ts
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));
```

Import `LocalizedStreamdown` alongside `buildStreamdownTranslations`, then add this test:

```ts
describe("LocalizedStreamdown", () => {
  it("renders inline and display formulas alongside ordinary Markdown", () => {
    const html = renderToStaticMarkup(
      createElement(LocalizedStreamdown, {
        children: "**Equation:** $E = mc^2$\n\n$$\n\\int_0^1 x^2 \\, dx\n$$",
      }),
    );

    expect(html).toContain("<strong>Equation:</strong>");
    expect(html).toContain('class="katex"');
    expect(html).toContain('class="katex-display"');
  });
});
```

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
pnpm test src/renderer/components/LocalizedStreamdown.test.ts
```

Expected: the new test fails because the rendered HTML contains the literal formula source and no `class="katex"` / `class="katex-display"` markup.

- [ ] **Step 3: Install the official Streamdown math plugin**

Run:

```bash
pnpm add -w @streamdown/math@^1.0.2
```

Expected: `package.json` gains `@streamdown/math` under dependencies and `pnpm-lock.yaml` records version 1.0.2 plus its dependency links.

- [ ] **Step 4: Configure the shared wrapper**

Update `src/renderer/components/LocalizedStreamdown.tsx`:

```tsx
import { createMathPlugin } from "@streamdown/math";
```

Create the plugin once at module scope:

```tsx
const math = createMathPlugin({ singleDollarTextMath: true });
```

Preserve any caller plugins while providing math by default:

```tsx
export function LocalizedStreamdown({ translations, plugins, ...props }: StreamdownProps) {
  const { t } = useTranslation();
  const localized = buildStreamdownTranslations(t);
  return (
    <Streamdown
      plugins={{ math, ...plugins }}
      translations={{ ...localized, ...translations }}
      {...props}
    />
  );
}
```

- [ ] **Step 5: Load KaTeX and plugin styling**

Add the KaTeX stylesheet with the other imports near the top of `src/index.css`, then add the plugin source beside the existing Streamdown source:

```css
@import "katex/dist/katex.min.css";

@source "../node_modules/streamdown/dist/*.js";
@source "../node_modules/@streamdown/math/dist/*.js";
```

- [ ] **Step 6: Run the focused test and verify GREEN**

Run:

```bash
pnpm test src/renderer/components/LocalizedStreamdown.test.ts
```

Expected: all tests in `LocalizedStreamdown.test.ts` pass, including KaTeX inline and display markup assertions.

- [ ] **Step 7: Add the user-facing changeset**

Create `.changeset/markdown-math-rendering.md`:

```markdown
---
"marginalia": minor
---

Render inline and display LaTeX formulas in AI replies, book summaries, and saved book notes.
```

- [ ] **Step 8: Run repository verification**

Run:

```bash
pnpm typecheck
pnpm lint
pnpm format:check
pnpm test
```

Expected: every command exits with status 0 and no new warnings or failures.

- [ ] **Step 9: Commit the implementation**

```bash
git add package.json pnpm-lock.yaml src/renderer/components/LocalizedStreamdown.test.ts src/renderer/components/LocalizedStreamdown.tsx src/index.css .changeset/markdown-math-rendering.md docs/superpowers/plans/2026-07-13-markdown-math-rendering.md
git commit -m "feat(renderer): render markdown math formulas closes #102"
```
