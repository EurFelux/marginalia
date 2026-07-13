# Markdown Math Rendering Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Render `$...$`, `$$...$$`, `\(...\)`, and `\[...\]` LaTeX formulas within the width of every Markdown surface backed by `LocalizedStreamdown`.

**Architecture:** Install Streamdown's official math plugin and configure it once at module scope in the shared renderer wrapper. Load KaTeX and plugin styles globally so existing AI messages, summaries, and notes gain math rendering without caller changes.

**Tech Stack:** React 19, Streamdown 2.5, `@streamdown/math` 1.0, KaTeX, Vitest 4, Tailwind CSS 4

## Global Constraints

- Support `$...$` for inline formulas.
- Support `$$...$$` on separate lines for display formulas.
- Support `\(...\)` for inline formulas and `\[...\]` for display formulas.
- Preserve alternative delimiter text inside inline and fenced code.
- Keep long display formulas inside the Markdown container with local horizontal scrolling.
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

### Task 2: Normalize Model Delimiters and Contain Display Math

**Files:**

- Create: `src/renderer/components/markdown-math.ts`
- Modify: `src/renderer/components/LocalizedStreamdown.test.ts`
- Modify: `src/renderer/components/LocalizedStreamdown.tsx`
- Modify: `.changeset/markdown-math-rendering.md`
- Modify: `docs/superpowers/specs/2026-07-13-markdown-math-rendering-design.md`
- Modify: `docs/superpowers/plans/2026-07-13-markdown-math-rendering.md`

**Interfaces:**

- Produces: `normalizeMathDelimiters(markdown: string): string`, converting model-style delimiters outside code spans and fences.
- Consumes: normalized Markdown in `LocalizedStreamdown` before it reaches Streamdown.

- [ ] **Step 1: Add failing component regression tests**

Add these tests to `LocalizedStreamdown.test.ts`:

````ts
it("renders model-style inline and display math delimiters", () => {
  const html = renderToStaticMarkup(
    createElement(LocalizedStreamdown, {
      children: "Inline \\(E = mc^2\\)\n\n\\[\n\\int_0^1 x^2 \\, dx\n\\]",
    }),
  );

  expect(html).toContain('Inline <span class="katex">');
  expect(html).not.toContain("\\(E = mc^2\\)");
  expect(html).toContain('class="katex-display"');
});

it("preserves alternative delimiters inside code", () => {
  const html = renderToStaticMarkup(
    createElement(LocalizedStreamdown, {
      children: "`\\(inline\\)`\n\n```tex\n\\[fenced\\]\n```",
    }),
  );

  expect(html).toContain("\\(inline\\)");
  expect(html).toContain("\\[fenced\\]");
  expect(html).not.toContain('class="katex"');
});

it("contains wide display formulas with local horizontal scrolling", () => {
  const html = renderToStaticMarkup(
    createElement(LocalizedStreamdown, {
      children: "$$\n\\sum_{i=1}^{n} i\n$$",
    }),
  );

  expect(html).toContain("[&amp;_.katex-display]:max-w-full");
  expect(html).toContain("[&amp;_.katex-display]:overflow-x-auto");
  expect(html).toContain("[&amp;_.katex-display]:overflow-y-hidden");
});

describe("normalizeMathDelimiters", () => {
  it("treats an unmatched backtick run as literal Markdown", () => {
    expect(normalizeMathDelimiters("Unmatched `code\n\\(x\\)")).toBe("Unmatched `code\n$x$");
  });

  it("rejects a backtick fence whose info string contains a backtick", () => {
    expect(normalizeMathDelimiters("```lang`bad\n\\(x\\)")).toBe("```lang`bad\n$x$");
  });

  it("does not pair an unmatched backtick across fenced code", () => {
    const backtickFence = normalizeMathDelimiters(
      "`unclosed\n```\n`\n\\(must stay literal\\)\n```\n\\(outside\\)",
    );
    expect(backtickFence).toContain("```\n`\n\\(must stay literal\\)\n```");
    expect(backtickFence).toContain("\n$outside$");

    const tildeFence = normalizeMathDelimiters(
      "`unclosed\n~~~\n`\n\\[must stay literal\\]\n~~~\n\\[outside\\]",
    );
    expect(tildeFence).toContain("~~~\n`\n\\[must stay literal\\]\n~~~");
    expect(tildeFence).toContain("\n$$\noutside\n$$\n");
  });

  it("does not treat escaped backticks as code span openers", () => {
    expect(normalizeMathDelimiters("\\`\\(x\\)\\`")).toBe("\\`$x$\\`");
  });

  it("preserves unmatched closing delimiters while normalizing streaming openers", () => {
    expect(normalizeMathDelimiters("right \\) bracket \\]")).toBe("right \\) bracket \\]");
    expect(normalizeMathDelimiters("\\(x")).toBe("$x");
    expect(normalizeMathDelimiters("\\[x")).toBe("\n$$\nx");
  });
});
````

- [ ] **Step 2: Run the focused test and verify RED**

Run `pnpm test src/renderer/components/LocalizedStreamdown.test.ts`.

Expected: alternative delimiters render as parentheses/brackets instead of KaTeX, and no display overflow class is present.

- [ ] **Step 3: Implement the delimiter normalizer**

Create `markdown-math.ts` with linear passes that first index fenced-code
ranges, then index same-length backtick runs inside each non-fence segment,
and finally normalize delimiters:

- Converts an unescaped `\(` opener and its matching `\)` closer to `$`.
- Converts an unescaped `\[` opener and its matching `\]` closer to `$$` lines.
- Converts unmatched openers so Streamdown can complete streaming formulas, but preserves unmatched closing delimiters literally.
- Protects only confirmed, same-length inline backtick spans across lines; an unmatched backtick run remains literal Markdown and must not suppress later math.
- Never pairs an inline backtick run across a backtick or tilde fenced-code range, and does not treat escaped backticks as code-span openers.
- Tracks backtick and tilde fenced code blocks, including language info strings.
- Rejects backtick fence openers whose info string contains a backtick, matching CommonMark.
- Accepts only spaces, tabs, and an optional carriage return after a closing fence.
- Leaves all characters inside code spans and fences unchanged.

- [ ] **Step 4: Apply normalization and overflow classes**

In `LocalizedStreamdown.tsx`, normalize the string child before passing it to Streamdown. Merge the caller's `className` with Tailwind descendant variants that apply `max-w-full overflow-x-auto overflow-y-hidden` to `.katex-display`.

```tsx
import { cn } from "@renderer/lib/utils";
import { normalizeMathDelimiters } from "./markdown-math";

const mathDisplayClasses =
  "[&_.katex-display]:max-w-full [&_.katex-display]:overflow-x-auto [&_.katex-display]:overflow-y-hidden";

export function LocalizedStreamdown({
  children,
  className,
  translations,
  plugins,
  ...props
}: StreamdownProps) {
  const { t } = useTranslation();
  const localized = buildStreamdownTranslations(t);
  return (
    <Streamdown
      className={cn(mathDisplayClasses, className)}
      plugins={{ math, ...plugins }}
      translations={{ ...localized, ...translations }}
      {...props}
    >
      {normalizeMathDelimiters(children ?? "")}
    </Streamdown>
  );
}
```

- [ ] **Step 5: Run the focused test and verify GREEN**

Run `pnpm test src/renderer/components/LocalizedStreamdown.test.ts`.

Expected: all renderer tests pass, including alternative delimiter, code preservation, and overflow assertions.

- [ ] **Step 6: Update the changeset and verify the repository**

Update the changeset to mention common LaTeX delimiter support and contained scrolling. Run `pnpm typecheck`, `pnpm lint`, changed-file formatting, `pnpm test`, and `pnpm package`.

```bash
pnpm typecheck
pnpm lint
pnpm exec oxfmt --check src/renderer/components/markdown-math.ts src/renderer/components/LocalizedStreamdown.test.ts src/renderer/components/LocalizedStreamdown.tsx .changeset/markdown-math-rendering.md docs/superpowers/specs/2026-07-13-markdown-math-rendering-design.md docs/superpowers/plans/2026-07-13-markdown-math-rendering.md
pnpm test
pnpm package
```

- [ ] **Step 7: Commit the follow-up**

Stage the Task 2 files and commit with `fix(renderer): handle common math delimiters and overflow`.

```bash
git add src/renderer/components/markdown-math.ts src/renderer/components/LocalizedStreamdown.test.ts src/renderer/components/LocalizedStreamdown.tsx .changeset/markdown-math-rendering.md docs/superpowers/specs/2026-07-13-markdown-math-rendering-design.md docs/superpowers/plans/2026-07-13-markdown-math-rendering.md
git commit -m "fix(renderer): handle common math delimiters and overflow"
```
