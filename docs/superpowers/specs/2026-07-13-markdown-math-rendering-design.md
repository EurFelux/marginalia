# Markdown Math Rendering Design

**Issue:** [#102](https://github.com/EurFelux/marginalia/issues/102)

## Goal

Render LaTeX formulas in every user-facing Markdown surface that already uses
the shared `LocalizedStreamdown` component: AI replies, book summaries, and
saved book notes.

The supported delimiters are:

- `$...$` for inline formulas.
- `$$...$$` on separate lines for display formulas.

## Design

Use Streamdown's official `@streamdown/math` plugin instead of assembling a
separate Remark/Rehype pipeline. Create one module-level math plugin with
`createMathPlugin({ singleDollarTextMath: true })` and pass it through the
`plugins` prop in `LocalizedStreamdown`. Keeping this configuration in the
shared wrapper makes all existing and future Markdown consumers consistent.

Load `katex/dist/katex.min.css` from the renderer and add the math plugin's
distribution files to Tailwind's `@source` scan. No main-process, IPC, database,
or persisted-content changes are required.

## Error Handling

KaTeX's normal parse-error rendering remains the fallback for invalid LaTeX;
an invalid formula must not crash or suppress the surrounding Markdown. The
plugin's default error color will inherit Streamdown's muted foreground token.

Enabling single-dollar math creates the usual Markdown ambiguity with currency.
Literal dollar signs can be escaped as `\$` when needed. This trade-off is
accepted in favor of the familiar inline-math syntax.

## Testing

Add a renderer component regression test that renders `LocalizedStreamdown`
and verifies:

1. `$E = mc^2$` produces inline KaTeX markup.
2. A multiline `$$...$$` expression produces display KaTeX markup.
3. Ordinary Markdown still renders normally alongside the math plugin.

Run the focused renderer test first, then the repository typecheck, lint, and
full test suite.
