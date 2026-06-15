/**
 * PDF 页列表滚动几何（全书同尺寸前提，与 PdfReader 的 Virtuoso 布局耦合）：
 * 每项总高 = pageH + PAGE_GAP（页盒 py-2 上下各 8px），第 page 页（1-based）
 * 内容顶 = (page-1)*(pageH+PAGE_GAP) + PAGE_PADDING_Y。
 * 进度精确恢复与缩放光标锚点共用这套换算。
 */
export const PAGE_PADDING_Y = 8;
export const PAGE_GAP = 16;

/** 内容 Y（scrollTop / 光标绝对 Y）所在页：+PAGE_PADDING_Y 使翻页界落在上页内容底（缝起点），
 *  内容像素恒归正确页、整条页缝归下一页（页内比例由 intraPageRatio 再 clamp 到边界）。 */
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

/**
 * 缩放竖向复位的 Virtuoso `scrollToIndex({ align: "start", offset })` offset：
 * align:'start' 把该页（itemHeight = pageH + PAGE_GAP）顶对齐视口顶，落点
 * scrollTop = (page-1)*(pageH+PAGE_GAP) + offset；要让页内比例 ratio 处的内容点钉在视口
 * anchorY（光标 Y / 视口中心），即 scrollTop = scrollTopFor(page, ratio, pageH) - anchorY，
 * 解得 offset = PAGE_PADDING_Y + ratio*pageH - anchorY（与页号无关）。
 * 用 Virtuoso 自身命令复位（非裸 scroller.scrollTop），避免被其 resize 重新落位冲掉。
 */
export function zoomScrollOffset(ratio: number, pageH: number, anchorY: number): number {
  return PAGE_PADDING_Y + ratio * pageH - anchorY;
}

/**
 * 缩放横向复位（缩放到点，scale = 新/旧 pageH）：锚点 X 处内容点缩放后仍钉回视口 anchorX。
 * 横向滚动不归 Virtuoso 管，直接设 scroller.scrollLeft。页居中↔溢出切换处略有近似。
 */
export function zoomScrollLeft(oldScrollLeft: number, anchorX: number, scale: number): number {
  return Math.max(0, (oldScrollLeft + anchorX) * scale - anchorX);
}
