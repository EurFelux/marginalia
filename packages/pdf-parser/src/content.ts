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
 * 提取页范围纯文本：页间插入页边界标记 `[p.N]`（spec §5.1——模型可在章节
 * 文本中引用页码并跳转 readPage 精读），再按字符偏移切片。
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
    const parts: string[] = [];
    const last = Math.min(endPage, doc.numPages);
    for (let p = Math.max(1, startPage); p <= last; p++) {
      const text = (await pageText(doc, p)).replace(/\s+/g, " ").trim();
      parts.push(`[p.${p}]`);
      if (text) parts.push(text);
    }
    const full = parts.join("\n\n");
    const text = full.slice(offset, offset + maxChars);
    const nextOffset = offset + text.length;
    return { text, hasMore: nextOffset < full.length, nextOffset };
  } finally {
    await doc.cleanup();
    await doc.loadingTask.destroy();
  }
}
