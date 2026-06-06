/** PDF 进度 locator（spec §4）：`pdf:` 前缀 + JSON。存储层黑盒，仅 PDF reader 解释。 */
export interface PdfProgressLocator {
  page: number; // 1-based
  scrollRatio: number; // 页内滚动比例 [0,1)
}

export function makePdfLocator(loc: PdfProgressLocator): string {
  return `pdf:${JSON.stringify({ page: loc.page, scrollRatio: loc.scrollRatio })}`;
}

export function parsePdfLocator(s: string): PdfProgressLocator | null {
  if (!s.startsWith("pdf:")) return null;
  try {
    const v: unknown = JSON.parse(s.slice(4));
    if (
      typeof v === "object" &&
      v !== null &&
      typeof (v as { page?: unknown }).page === "number" &&
      (v as { page: number }).page >= 1
    ) {
      const ratio = (v as { scrollRatio?: unknown }).scrollRatio;
      return {
        page: (v as { page: number }).page,
        scrollRatio: typeof ratio === "number" ? ratio : 0,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * PDF 标注 locatorRange（spec §4）：页内文本流字符偏移（[start, end) 闭开区间）。
 * 坐标空间 = textLayer DOM 文本流（getTextContent items 顺序，不含 EOL 合成换行），
 * 与渲染层选区/（P3）高亮绘制同一空间；与主进程「章内偏移」互不转换。
 */
export interface PdfRangeLocator {
  page: number; // 1-based
  start: number;
  end: number;
}

export function makePdfLocatorRange(r: PdfRangeLocator): string {
  return `pdf:${JSON.stringify({ page: r.page, start: r.start, end: r.end })}`;
}

export function parsePdfLocatorRange(s: string): PdfRangeLocator | null {
  if (!s.startsWith("pdf:")) return null;
  try {
    const v: unknown = JSON.parse(s.slice(4));
    if (typeof v !== "object" || v === null) return null;
    const { page, start, end } = v as { page?: unknown; start?: unknown; end?: unknown };
    if (typeof page !== "number" || !Number.isInteger(page) || page < 1) return null;
    if (typeof start !== "number" || !Number.isInteger(start) || start < 0) return null;
    if (typeof end !== "number" || !Number.isInteger(end) || end < start) return null;
    return { page, start, end };
  } catch {
    return null;
  }
}
