# Markdown Math Rendering Design

**Issue:** [#102](https://github.com/EurFelux/marginalia/issues/102)

## Goal

Render LaTeX formulas in every user-facing Markdown surface that already uses
the shared `LocalizedStreamdown` component: AI replies, book summaries, and
saved book notes.

The supported delimiters are:

- `$...$` for inline formulas.
- `$$...$$` on separate lines for display formulas.
- `\(...\)` for model-generated inline formulas.
- `\[...\]` for model-generated display formulas.

## Design

Use Streamdown's official `@streamdown/math` plugin instead of assembling a
separate Remark/Rehype pipeline. Create one module-level math plugin with
`createMathPlugin({ singleDollarTextMath: true })` and pass it through the
`plugins` prop in `LocalizedStreamdown`. Keeping this configuration in the
shared wrapper makes all existing and future Markdown consumers consistent.

Before rendering, normalize the alternative `\(...\)` and `\[...\]`
delimiters to their dollar equivalents. The normalizer must skip inline code
and fenced code blocks so LaTeX examples remain literal. This also covers the
delimiter convention commonly emitted by language models without changing
stored Markdown.

The normalizer first indexes fenced-code ranges, then indexes same-length
backtick runs within each remaining segment. This keeps processing linear,
prevents an unmatched inline backtick from crossing into a later fence, and
protects only confirmed code spans. Unmatched opening math delimiters are
normalized for progressive streaming, while unmatched closing delimiters stay
literal.

Load `katex/dist/katex.min.css` from the renderer and add the math plugin's
distribution files to Tailwind's `@source` scan. No main-process, IPC, database,
or persisted-content changes are required.

KaTeX display formulas are intrinsically non-wrapping. Constrain every
`.katex-display` descendant to the Markdown container width and give it local
horizontal overflow so long formulas scroll inside the message bubble instead
of widening or escaping it.

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

1. `$E = mc^2$` and `\(E = mc^2\)` produce inline KaTeX markup.
2. Multiline `$$...$$` and `\[...\]` expressions produce display KaTeX markup.
3. Alternative delimiters remain literal inside inline and fenced code.
4. Display math receives a width constraint and local horizontal scrolling.
5. Ordinary Markdown still renders normally alongside the math plugin.
6. Incomplete backticks, escaped backticks, invalid fence info strings, and
   backtick/tilde fence boundaries do not suppress or expose math incorrectly.

Run the focused renderer test first, then the repository typecheck, lint, and
full test suite.
