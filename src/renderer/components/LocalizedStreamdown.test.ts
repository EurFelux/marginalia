import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { defaultTranslations, type StreamdownTranslations } from "streamdown";
import { buildStreamdownTranslations, LocalizedStreamdown } from "./LocalizedStreamdown";
import { normalizeMathDelimiters } from "./markdown-math";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (_key: string, fallback: string) => fallback,
  }),
}));

const streamdownKeys: Array<keyof StreamdownTranslations> = [
  "close",
  "copied",
  "copyCode",
  "copyLink",
  "copyTable",
  "copyTableAsCsv",
  "copyTableAsMarkdown",
  "copyTableAsTsv",
  "downloadDiagram",
  "downloadDiagramAsMmd",
  "downloadDiagramAsPng",
  "downloadDiagramAsSvg",
  "downloadFile",
  "downloadImage",
  "downloadTable",
  "downloadTableAsCsv",
  "downloadTableAsMarkdown",
  "exitFullscreen",
  "externalLinkWarning",
  "imageNotAvailable",
  "mermaidFormatMmd",
  "mermaidFormatPng",
  "mermaidFormatSvg",
  "openExternalLink",
  "openLink",
  "tableFormatCsv",
  "tableFormatMarkdown",
  "tableFormatTsv",
  "viewFullscreen",
];

describe("buildStreamdownTranslations", () => {
  it("maps every Streamdown UI label through i18n", () => {
    const t = ((key: string) => `[${key}]`) as TFunction;
    const out = buildStreamdownTranslations(t);

    expect(Object.keys(out).sort()).toEqual([...streamdownKeys].sort());
    expect(out.openExternalLink).toBe("[streamdown.openExternalLink]");
    expect(out.copyCode).toBe("[streamdown.copyCode]");
    expect(out.downloadTableAsMarkdown).toBe("[streamdown.downloadTableAsMarkdown]");
  });

  it("falls back to Streamdown's upstream default labels", () => {
    const t = ((_: string, fallback: string) => fallback) as TFunction;

    expect(buildStreamdownTranslations(t)).toEqual(defaultTranslations);
  });
});

describe("LocalizedStreamdown", () => {
  it("renders inline and display formulas alongside ordinary Markdown", () => {
    const html = renderToStaticMarkup(
      createElement(LocalizedStreamdown, {
        children: "**Equation:** $E = mc^2$\n\n$$\n\\int_0^1 x^2 \\, dx\n$$",
      }),
    );

    expect(html).toContain('data-streamdown="strong">Equation:</span>');
    expect(html).toContain('data-streamdown="strong">Equation:</span> <span class="katex">');
    expect(html).not.toContain("$E = mc^2$");
    expect(html).toContain('class="katex-display"');
  });

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
