import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TFunction } from "i18next";
import { defaultTranslations, type StreamdownTranslations } from "streamdown";
import { buildStreamdownTranslations, LocalizedStreamdown } from "./LocalizedStreamdown";

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
});
