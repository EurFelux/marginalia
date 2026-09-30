import type { PDFDocumentProxy } from "pdfjs-dist";
import { openPdf, pageText } from "./parse";
import type { ChapterTextSlice } from "./types";

export interface PdfReadOptions {
  startPage: number; // 1-based 闭区间
  endPage: number;
  offset?: number;
  maxChars?: number;
}

const DEFAULT_MAX_CHARS = 20_000; // 与 epub-parser 对齐

/**
 * 在已打开的 doc 上构造页范围章节文本：逐页提取纯文本，页间插入页边界标记
 * `[p.N]`，页与页以 `\n\n` 拼接（spec §5.1——模型可在章节文本中引用页码并跳转
 * readPage 精读）。返回完整字符串，不分页、不处理 offset；调用方负责 doc 的生命周期。
 * 这是 readChapterText 的坐标空间：offset 索引的就是本函数的返回值。
 */
export async function chapterPdfText(
  doc: PDFDocumentProxy,
  startPage: number,
  endPage: number,
): Promise<string> {
  const parts: string[] = [];
  const last = Math.min(endPage, doc.numPages);
  for (let p = Math.max(1, startPage); p <= last; p++) {
    const text = (await pageText(doc, p)).replace(/\s+/g, " ").trim();
    parts.push(`[p.${p}]`);
    if (text) parts.push(text);
  }
  return parts.join("\n\n");
}

/**
 * 提取页范围纯文本（chapterPdfText 构造，含 `[p.N]` 页边界标记），再按字符偏移切片。
 * 注意：此处的 offset 是「章内偏移」（含标记），与标注 locator 的「页内偏移」
 * 是两个独立坐标空间，互不转换（spec §5.1 偏移空间注记）。
 */

export async function extractPdfText(
  bytes: Uint8Array,
  opts: PdfReadOptions,
): Promise<ChapterTextSlice> {
  const { startPage, endPage, offset = 0, maxChars = DEFAULT_MAX_CHARS } = opts;
  const doc = await openPdf(bytes);
  try {
    const full = await chapterPdfText(doc, startPage, endPage);
    // clamp 越界 offset：nextOffset 永远 ≤ full.length，调用方持久化续传安全
    //（不 clamp 时越界 offset 会被原样回传，形成永远空切片的静默循环）。
    const start = Math.min(offset, full.length);
    const text = full.slice(start, start + maxChars);
    const nextOffset = start + text.length;
    return { text, hasMore: nextOffset < full.length, nextOffset };
  } finally {
    await doc.cleanup();
    await doc.loadingTask.destroy();
  }
}
