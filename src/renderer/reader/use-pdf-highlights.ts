import { useEffect, useState } from "react";
import {
  rangeFromOffsets,
  relativeRects,
  type OverlayRect,
  type PdfPageAnno,
} from "./pdf-annotations";

/** 一条可绘制矩形：页内偏移条目 + 它的一个矩形（条目跨行 = 多条记录，条目相同）。 */
export type TextLayerRect<T> = T & { rect: OverlayRect };

/** 标注高亮矩形。 */
export type HighlightRect = TextLayerRect<PdfPageAnno>;

/** 命中测试：相对页容器的点 (x, y) 落在哪条高亮矩形内（点击编辑与 hover cursor 共用）。 */
export function hitHighlight(
  highlights: HighlightRect[],
  x: number,
  y: number,
): HighlightRect | undefined {
  return highlights.find(
    (h) =>
      x >= h.rect.left &&
      x <= h.rect.left + h.rect.width &&
      y >= h.rect.top &&
      y <= h.rect.top + h.rect.height,
  );
}

/**
 * 本页文本层上一组偏移区间的矩形（标注高亮与搜索命中共用）：textLayer 渲染就绪（renderPage done）后，
 * 把每个条目的页内偏移经 Range.getClientRects() 转成相对页容器的矩形。偏移越界的条目画不出 → 跳过
 * （spec §11：selectedText 重锚定兜底 v1 不实现）。zoom 换档时 PdfPage 整体重挂
 * （computeItemKey 含 pageW），矩形随新布局重算。
 */
export function useTextLayerRects<T extends { start: number; end: number }>(
  items: readonly T[],
  textLayer: HTMLDivElement | null,
  ready: boolean,
): TextLayerRect<T>[] {
  const [rects, setRects] = useState<TextLayerRect<T>[]>([]);
  useEffect(() => {
    if (!ready || !textLayer || items.length === 0) {
      setRects([]);
      return;
    }
    const containerRect = textLayer.getBoundingClientRect();
    const out: TextLayerRect<T>[] = [];
    for (const item of items) {
      const range = rangeFromOffsets(textLayer, item.start, item.end);
      if (!range) continue;
      for (const rect of relativeRects(range.getClientRects(), containerRect)) {
        out.push({ ...item, rect });
      }
    }
    setRects(out);
  }, [items, textLayer, ready]);
  return rects;
}
