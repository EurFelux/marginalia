import { getDocument } from "pdfjs-dist/legacy/build/pdf.mjs";
import type { PDFDocumentProxy } from "pdfjs-dist";
import type { ChapterRange, ParsedPdf, TocNode } from "./types";

/** 文本层检测：采样页平均字符数低于此阈值 → 视为扫描版。 */
const TEXT_LAYER_MIN_AVG_CHARS = 50;
const TEXT_LAYER_SAMPLE_PAGES = 8;

/**
 * 打开 PDF 文档。pdfjs 会 transfer 传入 buffer（之后原数组不可用），
 * 故一律传副本；isEvalSupported:false 关掉字体代码 eval（沙箱友好）。
 */
export async function openPdf(bytes: Uint8Array): Promise<PDFDocumentProxy> {
  return getDocument({ data: bytes.slice() }).promise;
}

/** 单页纯文本：items.str 拼接，hasEOL 处换行。 */
export async function pageText(doc: PDFDocumentProxy, pageNo: number): Promise<string> {
  const page = await doc.getPage(pageNo);
  const tc = await page.getTextContent();
  let out = "";
  for (const item of tc.items) {
    if ("str" in item) {
      out += item.str;
      if (item.hasEOL) out += "\n";
    }
  }
  page.cleanup();
  return out;
}

interface FlatOutlineEntry {
  title: string;
  pageIndex: number; // 0-based
}

/** outline 压扁 + dest → 页号解析（named destination 经 getDestination 间接解析）。 */
async function flattenOutline(doc: PDFDocumentProxy): Promise<FlatOutlineEntry[]> {
  const outline = await doc.getOutline();
  if (!outline || outline.length === 0) return [];
  const flat: FlatOutlineEntry[] = [];
  type OutlineItem = (typeof outline)[number];
  const walk = async (items: OutlineItem[]): Promise<void> => {
    for (const item of items) {
      const explicit =
        typeof item.dest === "string" ? await doc.getDestination(item.dest) : item.dest;
      const ref = explicit?.[0];
      if (ref != null) {
        try {
          const pageIndex = await doc.getPageIndex(ref);
          if (item.title) flat.push({ title: item.title, pageIndex });
        } catch {
          // dest 指向不存在的页（畸形书）：跳过该条目，不让整书导入失败。
        }
      }
      if (item.items?.length) await walk(item.items);
    }
  };
  await walk(outline);
  // 起始页须单调不减（按阅读顺序）；个别乱序条目按起始页排序兜底。
  flat.sort((a, b) => a.pageIndex - b.pageIndex);
  return flat;
}

export async function parsePdf(bytes: Uint8Array): Promise<ParsedPdf> {
  const doc = await openPdf(bytes);
  try {
    const pageCount = doc.numPages;

    const meta = await doc.getMetadata();
    const info = meta.info as { Title?: string; Author?: string };
    const title = info.Title?.trim() || undefined;
    const author = info.Author?.trim() || undefined;

    // 扫描版检测：前 N 页平均字符数。
    const sample = Math.min(TEXT_LAYER_SAMPLE_PAGES, pageCount);
    let chars = 0;
    for (let p = 1; p <= sample; p++) chars += (await pageText(doc, p)).length;
    const hasTextLayer = sample > 0 && chars / sample >= TEXT_LAYER_MIN_AVG_CHARS;

    const flat = await flattenOutline(doc);
    let toc: TocNode[];
    let chapterRanges: ChapterRange[];
    if (flat.length > 0) {
      toc = flat.map((e, i) => ({ label: e.title, href: `pdf-ch:${i}` }));
      chapterRanges = flat.map((e, i) => ({
        startPage: e.pageIndex + 1,
        // endPage = 下一章起始页 − 1（= 0-based 下一章起点的 1-based 值 − 1 = flat[i+1].pageIndex）；
        // 末章到 pageCount；同页起章时至少含本章起始页（Math.max 兜底）。
        endPage:
          i + 1 < flat.length ? Math.max(e.pageIndex + 1, flat[i + 1]!.pageIndex) : pageCount,
      }));
    } else {
      toc = [];
      chapterRanges = [{ startPage: 1, endPage: pageCount }];
    }

    return { title, author, pageCount, toc, chapterRanges, hasTextLayer };
  } finally {
    await doc.cleanup();
    await doc.loadingTask.destroy();
  }
}
