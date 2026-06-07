/** 阅读进度计算（#48）：reader 上送 progress.percent 与 header 进度显示共用（一份计算两处消费）。 */

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** epub：spine 比例近似（epub-book 的 textLengths 惰性填充，字符加权不可行；spec §6.3）。 */
export function epubPercent(index: number, scrollRatio: number, sectionCount: number): number {
  if (sectionCount <= 0) return 0;
  return clamp01((index + clamp01(scrollRatio)) / sectionCount);
}

/** PDF：页比例，精确。 */
export function pdfPercent(page: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return clamp01(page / pageCount);
}
