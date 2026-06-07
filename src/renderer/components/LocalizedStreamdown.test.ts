import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { defaultTranslations, type StreamdownTranslations } from "streamdown";
import { buildStreamdownTranslations } from "./LocalizedStreamdown";

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
