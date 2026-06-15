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

/**
 * 滚轮/捏合缩放灵敏度：一档鼠标滚轮（|deltaY|≈100）≈ ±28%（exp(0.25)≈1.284）。
 * 触控板捏合每帧 deltaY 较小、需累积，故灵敏度偏大才有「跟手」的力度；高倍率时乘性步进更大。
 */
export const PDF_WHEEL_ZOOM_SENSITIVITY = 0.0025;

/**
 * 滚轮/捏合的下一缩放值（乘性，向上滚 deltaY<0 = 放大）。返回精确值**不取整**——
 * 调用方把它存 ref 累积、提交时才过 clampPdfZoom，防慢速捏合被 1% 取整卡死。
 */
export function nextZoom(current: number, deltaY: number): number {
  const next = current * Math.exp(-deltaY * PDF_WHEEL_ZOOM_SENSITIVITY);
  return Math.min(PDF_ZOOM_MAX, Math.max(PDF_ZOOM_MIN, next));
}
