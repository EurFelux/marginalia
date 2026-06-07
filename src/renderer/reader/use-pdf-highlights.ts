import { useEffect, useState } from "react";
import type { AnnotationStyle } from "@shared/annotations";
import {
  rangeFromOffsets,
  relativeRects,
  type OverlayRect,
  type PdfPageAnno,
} from "./pdf-annotations";

/** 一条可绘制矩形（一条标注跨行 = 多条记录，annoId 相同）。 */
export interface HighlightRect {
  annoId: string;
  style: AnnotationStyle;
  hasNote: boolean;
  rect: OverlayRect;
}

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
 * 本页高亮矩形组：textLayer 渲染就绪（renderPage done）后，把每条标注的页内偏移
 * 经 Range.getClientRects() 转成相对页容器的矩形。偏移越界的标注画不出 → 跳过
 * （spec §11：selectedText 重锚定兜底 v1 不实现）。zoom 换档时 PdfPage 整体重挂
 * （computeItemKey 含 pageW），矩形随新布局重算。
 */
export function usePdfHighlights(
  annos: PdfPageAnno[],
  textLayer: HTMLDivElement | null,
  ready: boolean,
): HighlightRect[] {
  const [rects, setRects] = useState<HighlightRect[]>([]);
  useEffect(() => {
    if (!ready || !textLayer || annos.length === 0) {
      setRects([]);
      return;
    }
    const containerRect = textLayer.getBoundingClientRect();
    const out: HighlightRect[] = [];
    for (const a of annos) {
      const range = rangeFromOffsets(textLayer, a.start, a.end);
      if (!range) continue;
      for (const rect of relativeRects(range.getClientRects(), containerRect)) {
        out.push({ annoId: a.id, style: a.style, hasNote: a.hasNote, rect });
      }
    }
    setRects(out);
  }, [annos, textLayer, ready]);
  return rects;
}
