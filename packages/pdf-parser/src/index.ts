// 注意：fixture（依赖 devDep pdf-lib）刻意不从主入口导出——主进程 bundle 会把
// 主入口的依赖图整体内联，pdf-lib 的 UMD/tslib 互操作在 bundle 后崩溃（dev 启动实锤）。
// 测试经 "@marginalia/pdf-parser/fixture" 子路径导入。
export type { ParsedPdf, TocNode, ChapterRange, ChapterTextSlice } from "./types";
export { parsePdf, openPdf, pageText } from "./parse";
export { extractPdfText } from "./content";
export type { PdfReadOptions } from "./content";
export { renderPageImage } from "./render";
export type { RenderOptions } from "./render";
