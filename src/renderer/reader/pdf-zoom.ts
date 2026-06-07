/** PDF 缩放范围与步进：相对适宽的倍率，±10% 细步进（对齐 ePub fontScale 模式，无档位表）。 */
export const PDF_ZOOM_MIN = 0.25;
export const PDF_ZOOM_MAX = 5;
export const PDF_ZOOM_STEP = 0.1;

/**
 * 把缩放倍率 normalize 到合法区间：越界 clamp 到端点，并归整到百分比整数
 * （round2 ≡ 百分比去小数：0.876 → 88%；同时防 ±0.1 连加的浮点累计误差外泄）。
 * 落盘存倍率原值（见 @shared/preferences 的 pdfZoom），消费时一律先过此函数。
 */
export function clampPdfZoom(scale: number): number {
  const clamped = Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, scale));
  return Math.round(clamped * 100) / 100;
}
