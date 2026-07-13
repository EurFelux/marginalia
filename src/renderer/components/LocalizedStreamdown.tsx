import type { TFunction } from "i18next";
import { createMathPlugin } from "@streamdown/math";
import { useTranslation } from "react-i18next";
import {
  defaultTranslations,
  Streamdown,
  type StreamdownProps,
  type StreamdownTranslations,
} from "streamdown";

const math = createMathPlugin({ singleDollarTextMath: true });

export function buildStreamdownTranslations(t: TFunction): StreamdownTranslations {
  return {
    close: t("streamdown.close", defaultTranslations.close),
    copied: t("streamdown.copied", defaultTranslations.copied),
    copyCode: t("streamdown.copyCode", defaultTranslations.copyCode),
    copyLink: t("streamdown.copyLink", defaultTranslations.copyLink),
    copyTable: t("streamdown.copyTable", defaultTranslations.copyTable),
    copyTableAsCsv: t("streamdown.copyTableAsCsv", defaultTranslations.copyTableAsCsv),
    copyTableAsMarkdown: t(
      "streamdown.copyTableAsMarkdown",
      defaultTranslations.copyTableAsMarkdown,
    ),
    copyTableAsTsv: t("streamdown.copyTableAsTsv", defaultTranslations.copyTableAsTsv),
    downloadDiagram: t("streamdown.downloadDiagram", defaultTranslations.downloadDiagram),
    downloadDiagramAsMmd: t(
      "streamdown.downloadDiagramAsMmd",
      defaultTranslations.downloadDiagramAsMmd,
    ),
    downloadDiagramAsPng: t(
      "streamdown.downloadDiagramAsPng",
      defaultTranslations.downloadDiagramAsPng,
    ),
    downloadDiagramAsSvg: t(
      "streamdown.downloadDiagramAsSvg",
      defaultTranslations.downloadDiagramAsSvg,
    ),
    downloadFile: t("streamdown.downloadFile", defaultTranslations.downloadFile),
    downloadImage: t("streamdown.downloadImage", defaultTranslations.downloadImage),
    downloadTable: t("streamdown.downloadTable", defaultTranslations.downloadTable),
    downloadTableAsCsv: t("streamdown.downloadTableAsCsv", defaultTranslations.downloadTableAsCsv),
    downloadTableAsMarkdown: t(
      "streamdown.downloadTableAsMarkdown",
      defaultTranslations.downloadTableAsMarkdown,
    ),
    exitFullscreen: t("streamdown.exitFullscreen", defaultTranslations.exitFullscreen),
    externalLinkWarning: t(
      "streamdown.externalLinkWarning",
      defaultTranslations.externalLinkWarning,
    ),
    imageNotAvailable: t("streamdown.imageNotAvailable", defaultTranslations.imageNotAvailable),
    mermaidFormatMmd: t("streamdown.mermaidFormatMmd", defaultTranslations.mermaidFormatMmd),
    mermaidFormatPng: t("streamdown.mermaidFormatPng", defaultTranslations.mermaidFormatPng),
    mermaidFormatSvg: t("streamdown.mermaidFormatSvg", defaultTranslations.mermaidFormatSvg),
    openExternalLink: t("streamdown.openExternalLink", defaultTranslations.openExternalLink),
    openLink: t("streamdown.openLink", defaultTranslations.openLink),
    tableFormatCsv: t("streamdown.tableFormatCsv", defaultTranslations.tableFormatCsv),
    tableFormatMarkdown: t(
      "streamdown.tableFormatMarkdown",
      defaultTranslations.tableFormatMarkdown,
    ),
    tableFormatTsv: t("streamdown.tableFormatTsv", defaultTranslations.tableFormatTsv),
    viewFullscreen: t("streamdown.viewFullscreen", defaultTranslations.viewFullscreen),
  };
}

export function LocalizedStreamdown({ translations, plugins, ...props }: StreamdownProps) {
  const { t } = useTranslation();
  // 不手写 useMemo：渲染层启用 React Compiler，自动记忆化。
  const localized = buildStreamdownTranslations(t);
  return (
    <Streamdown
      plugins={{ math, ...plugins }}
      translations={{ ...localized, ...translations }}
      {...props}
    />
  );
}
