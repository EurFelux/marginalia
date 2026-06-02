/** 选区 viewport 坐标矩形（形状对齐渲染层 SelectionInfo.rect）。 */
export interface ViewportRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/** 把 iframe 内坐标的 rect 平移为主视口坐标（加 iframe 在视口的左上偏移）。 */
export function toViewportRect(
  rangeRect: { left: number; top: number; width: number; height: number },
  iframeRect: { left: number; top: number },
): ViewportRect {
  return {
    x: rangeRect.left + iframeRect.left,
    y: rangeRect.top + iframeRect.top,
    width: rangeRect.width,
    height: rangeRect.height,
  };
}
