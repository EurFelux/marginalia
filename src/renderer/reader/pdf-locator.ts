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
