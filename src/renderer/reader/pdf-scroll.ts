/**
 * PDF 页列表滚动几何（全书同尺寸前提，与 PdfReader 的 Virtuoso 布局耦合）：
 * 每项总高 = pageH + PAGE_GAP（页盒 py-2 上下各 8px），第 page 页（1-based）
 * 内容顶 = (page-1)*(pageH+PAGE_GAP) + PAGE_PADDING_Y。
 * 进度精确恢复与缩放光标锚点共用这套换算。
 */
export const PAGE_PADDING_Y = 8;
export const PAGE_GAP = 16;

/** 内容 Y（scrollTop / 光标绝对 Y）所在页：+8 把页缝归属切在缝中点附近，吸收跨页累计的亚像素误差。 */
export function topPageAt(y: number, pageH: number, pageCount: number): number {
  const page = Math.floor((y + PAGE_PADDING_Y) / (pageH + PAGE_GAP)) + 1;
  return Math.min(pageCount, Math.max(1, page));
}

/** 内容 Y 相对第 page 页的页内比例，clamp 到 [0,1]（页缝区间收敛到边界）。 */
export function intraPageRatio(y: number, page: number, pageH: number): number {
  const contentTop = (page - 1) * (pageH + PAGE_GAP) + PAGE_PADDING_Y;
  return Math.min(1, Math.max(0, (y - contentTop) / pageH));
}

/** 反向：页号 + 页内比例 → 内容 Y（intraPageRatio 的逆）。 */
export function scrollTopFor(page: number, ratio: number, pageH: number): number {
  return (page - 1) * (pageH + PAGE_GAP) + PAGE_PADDING_Y + ratio * pageH;
}
