import { PDFDocument, PDFHexString, PDFName, PDFObject, StandardFonts } from "pdf-lib";

/** 每页正文模板：page N 的文本（fixture 断言用，足够长以通过文本层检测阈值）。 */
export function fixturePageText(page: number): string {
  return `This is the body text of page ${page}. `.repeat(4).trim();
}

interface TextPdfOptions {
  /** 是否带 outline（两章：Chapter One → p1，Chapter Two → p3）。 */
  outline: boolean;
  title?: string;
  author?: string;
  pages?: number; // 默认 3
  /** 测试用：第二个 outline 条目的 Dest 指向未注册的 ref（坏 dest，应被解析端跳过）。 */
  brokenDest?: boolean;
  /** 测试用：两个 outline 条目都指向第 1 页（同页起章）。 */
  samePageChapters?: boolean;
}

/**
 * 文字版 fixture：每页 drawText（有文本层）。
 * outline=true 时写入低层 /Outlines 字典（pdf-lib 无高层 API）：
 * Dest 数组首元素为页 ref，pdfjs 经 getPageIndex(ref) 解析回页号。
 */
export async function makeTextPdf(opts: TextPdfOptions): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  if (opts.title) doc.setTitle(opts.title);
  if (opts.author) doc.setAuthor(opts.author);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const pageCount = opts.pages ?? 3;
  for (let i = 1; i <= pageCount; i++) {
    const page = doc.addPage([400, 600]);
    page.drawText(fixturePageText(i), { x: 40, y: 560, size: 12, font, maxWidth: 320 });
  }

  if (opts.outline) {
    const ctx = doc.context;
    const pageRefs = doc.getPages().map((p) => p.ref);
    const entries = [
      { title: "Chapter One", pageIndex: 0 },
      { title: "Chapter Two", pageIndex: opts.samePageChapters ? 0 : 2 },
    ];
    const outlinesRef = ctx.nextRef();
    const itemRefs = entries.map(() => ctx.nextRef());
    entries.forEach((e, i) => {
      const destTarget = opts.brokenDest && i === 1 ? ctx.nextRef() : pageRefs[e.pageIndex]!;
      const dest = ctx.obj([destTarget, PDFName.of("XYZ"), null, null, null]);
      const item: Record<string, PDFObject> = {
        Title: PDFHexString.fromText(e.title),
        Parent: outlinesRef,
        Dest: dest,
      };
      if (i > 0) item.Prev = itemRefs[i - 1]!;
      if (i < entries.length - 1) item.Next = itemRefs[i + 1]!;
      ctx.assign(itemRefs[i]!, ctx.obj(item));
    });
    ctx.assign(
      outlinesRef,
      ctx.obj({
        Type: "Outlines",
        First: itemRefs[0]!,
        Last: itemRefs[itemRefs.length - 1]!,
        Count: entries.length,
      }),
    );
    doc.catalog.set(PDFName.of("Outlines"), outlinesRef);
  }

  return doc.save({ useObjectStreams: false });
}

/** 扫描版 fixture：3 张空页（无任何文本绘制 → getTextContent 为空 → hasTextLayer=false）。 */
export async function makeScannedPdf(): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  for (let i = 0; i < 3; i++) doc.addPage([400, 600]);
  return doc.save({ useObjectStreams: false });
}
