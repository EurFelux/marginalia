# EPUB Readable-Content Progress Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace equal-spine EPUB progress with a stable readable-text percentage derived from the viewport-top text position.

**Architecture:** Add a DOM-only text-coordinate module shared by the opening scan and live Range projection. `createEpubBook` scans one spine document at a time before exposing the book, then `EpubReader` combines the complete length vector with the current Range offset through a pure percentage function. Existing CFI persistence remains the location truth source; all-zero books alone retain the old spine fallback.

**Tech Stack:** TypeScript 6, Electron 41 renderer DOM, React 19, epub.js 0.3.93, happy-dom 20, Vitest 4, pnpm 11, Changesets

## Global Constraints

- Keep Electron pinned to `41.7.1`; do not change dependencies.
- Renderer React Compiler is enabled; do not add `useCallback` or `useMemo`.
- Use renderer `createLogger("epub")`; do not add bare `console.*` diagnostics.
- EPUB progress means UTF-16 readable-text position and must not depend on font size, line height, reading width, or window size.
- Keep PDF progress as `page / pageCount`.
- Keep existing CFI strings, progress schema, IPC contracts, preload API, database schema, and parser version unchanged.
- A single section scan failure records `warn`, stores weight `0`, unloads in `finally`, and does not block opening the book.
- Textless sections have weight `0`; an all-zero book falls back to `(index + scrollRatio) / sectionCount`.
- Do not add persisted weight caches or epub.js `locations.generate()`.
- Add a user-facing patch changeset in English.
- Follow TDD: observe every new/changed test fail before implementing its behavior.

---

## File Structure

- Create `src/renderer/reader/epub-text-position.ts`: DOM traversal, readable-node filtering, full-document length, first-readable-node lookup, and Range-to-offset projection.
- Create `src/renderer/reader/epub-text-position.test.ts`: happy-dom tests for stable text coordinates and ignored subtrees.
- Modify `src/renderer/reader/percent.ts`: weighted EPUB formula plus all-zero and missing-Range fallbacks.
- Modify `src/renderer/reader/percent.test.ts`: uneven-weight, zero-weight, fallback, and clamp coverage.
- Modify `src/renderer/reader/epub-book.ts`: pre-scan physical spine documents, expose immutable `textLengths`, and reuse the profile for VirtualDocs estimates.
- Create `src/renderer/reader/epub-book.test.ts`: fixture-backed profile and unload/reload integration coverage.
- Modify `src/renderer/reader/EpubReader.tsx`: project viewport-top Range to `{ cfi, textOffset }`, calculate one shared percentage, and warn once on pixel fallback.
- Create `.changeset/tidy-wolves-read.md`: patch changelog for user-visible EPUB progress correction.

---

### Task 1: Stable DOM text coordinates

**Files:**

- Create: `src/renderer/reader/epub-text-position.ts`
- Create: `src/renderer/reader/epub-text-position.test.ts`

**Interfaces:**

- Consumes: browser `Document`, `Node`, and `Range` only.
- Produces:

```ts
export function firstReadableTextNode(root: Node): Text | null;
export function readableTextLength(doc: Document): number;
export function readableTextOffsetAtRange(doc: Document, range: Range): number | null;
```

- [ ] **Step 1: Write the failing happy-dom tests**

Create `src/renderer/reader/epub-text-position.test.ts`:

```ts
// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import {
  firstReadableTextNode,
  readableTextLength,
  readableTextOffsetAtRange,
} from "./epub-text-position";

function docOf(body: string): Document {
  return new DOMParser().parseFromString(`<html><body>${body}</body></html>`, "text/html");
}

function pointAt(doc: Document, selector: string, offset = 0): Range {
  const text = doc.querySelector(selector)!.firstChild as Text;
  const range = doc.createRange();
  range.setStart(text, offset);
  range.collapse(true);
  return range;
}

describe("readable EPUB text coordinates", () => {
  it("counts nonblank body text nodes and projects a Range into the same coordinate", () => {
    const doc = docOf("<h1>Title</h1>  <p>Alpha <em>beta</em></p><li>Tail</li>");
    expect(readableTextLength(doc)).toBe(
      "Title".length + "Alpha ".length + "beta".length + "Tail".length,
    );
    expect(readableTextOffsetAtRange(doc, pointAt(doc, "em", 2))).toBe(
      "Title".length + "Alpha ".length + 2,
    );
  });

  it("ignores whitespace-only and explicitly non-readable subtrees", () => {
    const doc = docOf(`
      <p>Visible</p>
      <script>script text</script><style>style text</style><template>template text</template>
      <div hidden>hidden text</div><div aria-hidden="true">aria text</div>
    `);
    expect(readableTextLength(doc)).toBe("Visible".length);
    expect(firstReadableTextNode(doc.body)).toBe(doc.querySelector("p")!.firstChild);
  });

  it("keeps coordinates stable when annotation wrappers or CSS change", () => {
    const doc = docOf('<p id="a">Before</p><p id="b" style="font-size:12px">Target</p>');
    const before = readableTextOffsetAtRange(doc, pointAt(doc, "#b"));
    const target = doc.querySelector("#b")!;
    const text = target.firstChild!;
    const mark = doc.createElement("mark");
    mark.className = "anno";
    target.replaceChild(mark, text);
    mark.appendChild(text);
    target.setAttribute("style", "font-size:48px;line-height:3;width:10px");
    expect(readableTextLength(doc)).toBe("BeforeTarget".length);
    expect(readableTextOffsetAtRange(doc, pointAt(doc, "mark"))).toBe(before);
  });

  it("returns null for foreign or ignored Range starts", () => {
    const doc = docOf("<p>Visible</p><p hidden>Hidden</p>");
    const foreign = docOf("<p>Elsewhere</p>");
    expect(readableTextOffsetAtRange(doc, pointAt(foreign, "p"))).toBeNull();
    expect(readableTextOffsetAtRange(doc, pointAt(doc, "[hidden]"))).toBeNull();
  });
});
```

- [ ] **Step 2: Run the tests and verify the missing-module failure**

Run:

```bash
pnpm test src/renderer/reader/epub-text-position.test.ts
```

Expected: FAIL because `./epub-text-position` does not exist.

- [ ] **Step 3: Implement the DOM-only coordinate module**

Create `src/renderer/reader/epub-text-position.ts` with these exact rules:

```ts
const SHOW_TEXT = 4;
const IGNORED_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE"]);

function bodyOf(doc: Document): HTMLElement | null {
  return doc.body ?? (doc.querySelector("body") as HTMLElement | null);
}

function isInIgnoredSubtree(text: Text, body: HTMLElement): boolean {
  for (let el = text.parentElement; el && el !== body; el = el.parentElement) {
    if (
      IGNORED_TAGS.has(el.tagName) ||
      el.hasAttribute("hidden") ||
      el.getAttribute("aria-hidden") === "true"
    ) {
      return true;
    }
  }
  return false;
}

function isReadableText(text: Text, body: HTMLElement): boolean {
  return text.data.trim().length > 0 && body.contains(text) && !isInIgnoredSubtree(text, body);
}

function readableTexts(doc: Document): { body: HTMLElement; texts: Text[] } | null {
  const body = bodyOf(doc);
  if (!body) return null;
  const walker = doc.createTreeWalker(body, SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (isReadableText(text, body)) texts.push(text);
  }
  return { body, texts };
}

export function firstReadableTextNode(root: Node): Text | null {
  const doc = root.ownerDocument ?? (root as Document);
  const profile = readableTexts(doc);
  if (!profile) return null;
  return profile.texts.find((text) => root === text || root.contains(text)) ?? null;
}

export function readableTextLength(doc: Document): number {
  return readableTexts(doc)?.texts.reduce((sum, text) => sum + text.length, 0) ?? 0;
}

export function readableTextOffsetAtRange(doc: Document, range: Range): number | null {
  const profile = readableTexts(doc);
  const start = range.startContainer;
  if (!profile || start.ownerDocument !== doc || start.nodeType !== Node.TEXT_NODE) return null;
  let offset = 0;
  for (const text of profile.texts) {
    if (text === start) return offset + Math.min(Math.max(0, range.startOffset), text.length);
    offset += text.length;
  }
  return null;
}
```

If the Electron test runtime does not expose global `Node` in a happy-dom file, replace `Node.TEXT_NODE` with the DOM constant `3`; do not add a runtime dependency.

- [ ] **Step 4: Run focused tests and format check**

Run:

```bash
pnpm test src/renderer/reader/epub-text-position.test.ts
pnpm format:check
```

Expected: both PASS.

- [ ] **Step 5: Commit the coordinate module**

```bash
git add src/renderer/reader/epub-text-position.ts src/renderer/reader/epub-text-position.test.ts
git commit -m "feat(reader): add stable EPUB text coordinates"
```

---

### Task 2: Weighted percentage pure function

**Files:**

- Modify: `src/renderer/reader/percent.ts`
- Modify: `src/renderer/reader/percent.test.ts`

**Interfaces:**

- Consumes: `index`, viewport-top `textOffset`, complete physical-spine `textLengths`, and fallback `scrollRatio`.
- Produces:

```ts
export function epubPercent(
  index: number,
  textOffset: number | null,
  textLengths: readonly number[],
  scrollRatio: number,
): number;
```

- [ ] **Step 1: Replace EPUB tests with weighted expectations**

Keep PDF tests and replace the EPUB describe block in `percent.test.ts` with:

```ts
describe("epubPercent", () => {
  it("weights physical spine sections by readable text", () => {
    const lengths = [10, 90];
    expect(epubPercent(0, 0, lengths, 0)).toBe(0);
    expect(epubPercent(0, 5, lengths, 0.9)).toBe(0.05);
    expect(epubPercent(1, 0, lengths, 0)).toBe(0.1);
    expect(epubPercent(1, 45, lengths, 0)).toBe(0.55);
    expect(epubPercent(1, 90, lengths, 0)).toBe(1);
  });

  it("does not advance through zero-text sections", () => {
    const lengths = [0, 100, 0];
    expect(epubPercent(0, 0, lengths, 1)).toBe(0);
    expect(epubPercent(1, 0, lengths, 0)).toBe(0);
    expect(epubPercent(2, 0, lengths, 1)).toBe(1);
  });

  it("uses weighted pixel interpolation only when the current Range is unavailable", () => {
    expect(epubPercent(1, null, [10, 90], 0.5)).toBe(0.55);
  });

  it("falls back to equal spine progress for an all-zero book", () => {
    expect(epubPercent(0, null, [], 0.5)).toBe(0);
    expect(epubPercent(1, null, [0, 0], 0.5)).toBe(0.75);
  });

  it("clamps invalid indexes, offsets, ratios, and weights", () => {
    expect(epubPercent(-1, 10, [10], 0)).toBe(0);
    expect(epubPercent(2, 10, [10], 0)).toBe(1);
    expect(epubPercent(0, -5, [10], 0)).toBe(0);
    expect(epubPercent(0, 50, [10], 0)).toBe(1);
    expect(epubPercent(0, null, [Number.NaN, -2], -1)).toBe(0);
  });
});
```

- [ ] **Step 2: Run the focused tests and verify signature/expectation failures**

Run:

```bash
pnpm test src/renderer/reader/percent.test.ts
```

Expected: FAIL because the current function accepts `(index, scrollRatio, sectionCount)`.

- [ ] **Step 3: Implement the weighted formula**

Replace the EPUB function in `percent.ts` with:

```ts
const safeWeight = (value: number | undefined): number =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;

export function epubPercent(
  index: number,
  textOffset: number | null,
  textLengths: readonly number[],
  scrollRatio: number,
): number {
  const count = textLengths.length;
  if (count <= 0) return 0;
  const safeIndex = Math.trunc(index);
  if (safeIndex < 0) return 0;
  if (safeIndex >= count) return 1;

  const weights = textLengths.map(safeWeight);
  const total = weights.reduce((sum, weight) => sum + weight, 0);
  if (total <= 0) return clamp01((safeIndex + clamp01(scrollRatio)) / count);

  const before = weights.slice(0, safeIndex).reduce((sum, weight) => sum + weight, 0);
  const current = weights[safeIndex]!;
  const within =
    textOffset == null || !Number.isFinite(textOffset)
      ? clamp01(scrollRatio) * current
      : Math.min(current, Math.max(0, textOffset));
  return clamp01((before + within) / total);
}
```

- [ ] **Step 4: Run focused tests**

Run:

```bash
pnpm test src/renderer/reader/percent.test.ts
```

Expected: PASS, including unchanged PDF tests.

- [ ] **Step 5: Commit the pure formula**

```bash
git add src/renderer/reader/percent.ts src/renderer/reader/percent.test.ts
git commit -m "fix(reader): weight EPUB progress by text"
```

---

### Task 3: Pre-scan the physical spine profile

**Files:**

- Modify: `src/renderer/reader/epub-book.ts`
- Create: `src/renderer/reader/epub-book.test.ts`

**Interfaces:**

- Consumes: `readableTextLength(doc)` from Task 1.
- Produces: `EpubBook.textLengths: readonly number[]`; `textLengthAtIndex` reads the same immutable snapshot.

- [ ] **Step 1: Write fixture-backed profile tests**

Create `src/renderer/reader/epub-book.test.ts` with `// @vitest-environment happy-dom`. Use `makeFixtureEpub()` from `@marginalia/epub-parser` for the success path and assert:

```ts
const book = await createEpubBook(makeFixtureEpub());
expect(book.textLengths).toHaveLength(book.count);
expect(book.textLengths.every((length) => Number.isFinite(length) && length >= 0)).toBe(true);
expect(book.textLengths.reduce((sum, length) => sum + length, 0)).toBeGreaterThan(0);
for (let i = 0; i < book.count; i++) {
  expect(book.textLengthAtIndex(i)).toBe(book.textLengths[i]);
  expect(await book.loadSection(i)).toContain("<");
}
book.destroy();
```

Add a second test around an exported dependency-injected helper:

```ts
const unloads: number[] = [];
const warnings: Array<{ index: number; href: string; error: unknown }> = [];
const lengths = await scanSectionTextLengths(
  [
    { href: "a.xhtml", load: async () => docOf("<p>abc</p>"), unload: () => unloads.push(0) },
    {
      href: "bad.xhtml",
      load: async () => {
        throw new Error("bad");
      },
      unload: () => unloads.push(1),
    },
    { href: "c.xhtml", load: async () => docOf("<p>12345</p>"), unload: () => unloads.push(2) },
  ],
  (warning) => warnings.push(warning),
);
expect(lengths).toEqual([3, 0, 5]);
expect(unloads).toEqual([0, 1, 2]);
expect(warnings).toMatchObject([{ index: 1, href: "bad.xhtml" }]);
```

Define the local `docOf` helper with `DOMParser`, as in Task 1.

- [ ] **Step 2: Run the profile tests and verify interface failures**

Run:

```bash
pnpm test src/renderer/reader/epub-book.test.ts
```

Expected: FAIL because `textLengths` and `scanSectionTextLengths` do not exist.

- [ ] **Step 3: Add the dependency-injected scanner**

In `epub-book.ts`, add:

```ts
export interface TextScanSection {
  href: string;
  load: () => Promise<Document>;
  unload: () => void;
}

export interface TextScanWarning {
  index: number;
  href: string;
  error: unknown;
}

export async function scanSectionTextLengths(
  sections: readonly TextScanSection[],
  onWarning: (warning: TextScanWarning) => void,
): Promise<number[]> {
  const lengths = Array<number>(sections.length).fill(0);
  for (const [index, section] of sections.entries()) {
    try {
      lengths[index] = readableTextLength(await section.load());
    } catch (error) {
      onWarning({ index, href: section.href, error });
    } finally {
      section.unload();
    }
  }
  return lengths;
}
```

Import `readableTextLength` and create `const log = createLogger("epub")` using `@renderer/logger`.

- [ ] **Step 4: Wire scanning into `createEpubBook`**

After `sectionAt` is defined, build exactly `count` adapters. A missing section adapter throws from `load` and has a no-op unload; a real adapter calls `s.load(book.load.bind(book))`, converts its returned document element to `contents.ownerDocument`, and calls `s.unload()`:

```ts
const textLengths = await scanSectionTextLengths(
  Array.from({ length: count }, (_, index): TextScanSection => {
    const section = sectionAt(index);
    return {
      href: section?.href ?? `(missing section ${index})`,
      load: async () => {
        if (!section) throw new Error(`epub: missing spine section ${index}`);
        const contents = await section.load(book.load.bind(book));
        return contents.ownerDocument;
      },
      unload: () => section?.unload(),
    };
  }),
  ({ index, href, error }) => log.warn(`scan section text failed: ${index} ${href}`, error),
);
```

Then:

- add `readonly textLengths: readonly number[]` to `EpubBook`;
- expose `textLengths` in the returned object;
- change `textLengthAtIndex` to `textLengths[index] ?? 0`;
- remove the lazy `Map` and the `htmlToText` import/call from `loadSection`.

- [ ] **Step 5: Run profile and existing EPUB tests**

Run:

```bash
pnpm test src/renderer/reader/epub-book.test.ts
pnpm test src/renderer/reader/chapter-id-at-cfi.test.ts src/renderer/reader/current-anchor-chapter.test.ts
```

Expected: PASS. If happy-dom cannot satisfy epub.js blob/resource behavior, retain the dependency-injected scanner test as the integration seam and replace only the `createEpubBook(makeFixtureEpub())` case with a mocked `Section` adapter; do not weaken length, ordering, unload, reload, or warning assertions.

- [ ] **Step 6: Commit the complete profile**

```bash
git add src/renderer/reader/epub-book.ts src/renderer/reader/epub-book.test.ts
git commit -m "feat(reader): profile EPUB spine text on open"
```

---

### Task 4: Wire viewport Range to the shared progress value

**Files:**

- Modify: `src/renderer/reader/EpubReader.tsx`

**Interfaces:**

- Consumes: `firstReadableTextNode`, `readableTextOffsetAtRange`, `book.textLengths`, and the Task 2 `epubPercent` signature.
- Produces: one `{ cfi, textOffset }` projection used for header state and debounced persistence.

- [ ] **Step 1: Run typecheck to establish the expected call-site failure**

After Tasks 2–3, run:

```bash
pnpm typecheck
```

Expected: FAIL at `EpubReader.tsx` because it still calls the old `epubPercent(index, scrollRatio, count)` signature.

- [ ] **Step 2: Replace the local text-node helper and add a warn-once ref**

- Import `firstReadableTextNode` and `readableTextOffsetAtRange` from `./epub-text-position`.
- Delete the local `firstTextNode` function.
- Add `const offsetFallbackWarnedRef = useRef(false);` beside `restoredRef`.
- Reset it to `false` in the existing `[bookId]` reset effect.

- [ ] **Step 3: Return CFI and text offset from one viewport projection**

Replace `topElementCfi` with:

```ts
const topReadablePosition = (sectionIndex: number): { cfi: string; textOffset: number | null } => {
  const fallback = book!.cfiAtIndex(sectionIndex) ?? "";
  const frame = document.querySelector<HTMLIFrameElement>(
    `[data-section-index="${sectionIndex}"] iframe`,
  );
  const doc = frame?.contentDocument;
  const scroller = document.querySelector(".no-scrollbar");
  if (!doc || !frame || !scroller) return { cfi: fallback, textOffset: null };

  const targetInDoc = scroller.getBoundingClientRect().top - frame.getBoundingClientRect().top;
  const blocks = [...doc.querySelectorAll("p,h1,h2,h3,h4,h5,h6,li,blockquote,pre,figcaption")];
  let top: Element | null = null;
  for (const el of blocks) {
    if (el.getBoundingClientRect().top <= targetInDoc + 4) top = el;
    else break;
  }
  const el = top ?? blocks[0] ?? null;
  if (!el) return { cfi: fallback, textOffset: null };
  const text = firstReadableTextNode(el);
  if (!text) {
    return {
      cfi: book!.cfiFromElement(sectionIndex, el) ?? fallback,
      textOffset: null,
    };
  }

  const range = doc.createRange();
  range.setStart(text, 0);
  range.setEnd(text, Math.min(1, text.length));
  return {
    cfi: book!.cfiFromRange(sectionIndex, range) ?? fallback,
    textOffset: readableTextOffsetAtRange(doc, range),
  };
};
```

- [ ] **Step 4: Calculate and persist the weighted percentage**

At the start of `onTopSectionChange`, keep `topSectionIndexRef.current = index` but remove the old percent calculation. After `topReadablePosition` is called, calculate:

```ts
const { cfi, textOffset } = topReadablePosition(index);
if (textOffset == null && book.textLengthAtIndex(index) > 0 && !offsetFallbackWarnedRef.current) {
  offsetFallbackWarnedRef.current = true;
  log.warn(`text offset unavailable; using section scroll ratio: ${index}`);
}
const percent = epubPercent(index, textOffset, book.textLengths, meta.scrollRatio);
setReadingPercent(percent);
```

Keep the existing `percent` variable flowing unchanged into `progress.save`. Do not replace the separate AI `ReadingContext.offset` calculation; that remains chapter-relative and intentionally uses its current behavior.

- [ ] **Step 5: Verify typecheck and focused tests**

Run:

```bash
pnpm typecheck
pnpm test src/renderer/reader/percent.test.ts src/renderer/reader/epub-text-position.test.ts src/renderer/reader/epub-book.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit the reader integration**

```bash
git add src/renderer/reader/EpubReader.tsx
git commit -m "fix(reader): project EPUB progress from text position"
```

---

### Task 5: Changelog, regression suite, and real-book acceptance

**Files:**

- Create: `.changeset/tidy-wolves-read.md`
- Modify only if verification reveals an in-scope defect: files already listed in Tasks 1–4.

**Interfaces:**

- Consumes: completed weighted progress flow.
- Produces: release note and acceptance evidence for issue #105.

- [ ] **Step 1: Add the patch changeset**

Create `.changeset/tidy-wolves-read.md` containing:

```md
---
"marginalia": patch
---

Weight EPUB reading progress by readable text so uneven file packaging no longer distorts the percentage.
```

- [ ] **Step 2: Run the full automated verification**

Run each command independently:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

Expected: all exit 0. If formatting changes files, run `pnpm format`, inspect the diff, and rerun all four commands.

- [ ] **Step 3: Verify the real reproduction EPUB**

Use the user-provided file:

```text
/Users/heracles/Downloads/钢铁是怎样炼成的 (（苏）奥斯特洛夫斯基) (z-library.sk, 1lib.sk, z-lib.sk).epub
```

Open it in the development app and verify:

- first main-text section begins around 1%, not 55%;
- second main-text section begins around 40%, not 64%;
- the end of the main text is around 99%, not 73%;
- changing font size, line height, reading width, and window width at the same restored CFI leaves the rounded percentage unchanged;
- closing and reopening restores the same CFI and percentage;
- the recently-read shelf shows the newly saved percentage after returning to the library.

If GUI automation cannot read the Electron header reliably, add a temporary local-only diagnostic at the existing `epub` logger boundary, capture the three values, then remove the diagnostic before committing. Never leave bare `console.*` or sample-book paths in production code.

- [ ] **Step 4: Inspect final scope and commit**

Run:

```bash
git diff --check
git status --short
git diff --stat aabbe8e..HEAD
```

Confirm there are no database, IPC, preload, PDF, dependency, or unrelated file changes. Then commit the changeset and any final in-scope corrections:

```bash
git add .changeset src/renderer/reader
git commit -m "fix: stabilize EPUB text progress (closes #105)"
```

- [ ] **Step 5: Final verification after hooks**

Because prek may modify staged files, rerun:

```bash
git status --short
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
```

Expected: clean worktree and all commands exit 0.
