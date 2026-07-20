/** 阅读进度计算（#48）：reader 上送 progress.percent 与 header 进度显示共用（一份计算两处消费）。 */

const clamp01 = (v: number): number => Math.min(1, Math.max(0, v));

/** epub：以全书可读文本量加权；没有文本 profile 时降级为 spine 比例。 */
export function epubPercent(
  index: number,
  textOffset: number | null,
  textLengths: readonly number[],
  scrollRatio: number,
): number {
  const sectionCount = textLengths.length;
  if (sectionCount === 0) return 0;

  const safeIndex = Math.floor(index);
  if (safeIndex < 0) return 0;
  if (safeIndex >= sectionCount) return 1;

  const lengths = textLengths.map((length) => (Number.isFinite(length) ? Math.max(0, length) : 0));
  const total = lengths.reduce((sum, length) => sum + length, 0);
  const ratio = Number.isFinite(scrollRatio) ? clamp01(scrollRatio) : 0;

  if (total === 0) return clamp01((safeIndex + ratio) / sectionCount);

  const completed = lengths.slice(0, safeIndex).reduce((sum, length) => sum + length, 0);
  const currentLength = lengths[safeIndex] ?? 0;
  const current =
    textOffset === null || !Number.isFinite(textOffset)
      ? ratio * currentLength
      : Math.min(Math.max(textOffset, 0), currentLength);
  return clamp01((completed + current) / total);
}

/** PDF：页比例，精确。 */
export function pdfPercent(page: number, pageCount: number): number {
  if (pageCount <= 0) return 0;
  return clamp01(page / pageCount);
}
