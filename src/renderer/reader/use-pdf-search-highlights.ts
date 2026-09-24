import { useEffect, useState } from "react";
import { rangeFromOffsets, relativeRects, type OverlayRect } from "./pdf-annotations";

/** 本页的一个搜索命中（文本层文本流偏移，与 PDF 标注同一坐标空间）。 */
export interface PdfSearchMark {
  start: number;
  end: number;
  active: boolean;
}

export interface PdfSearchRect {
  rect: OverlayRect;
  active: boolean;
}

/** 空列表常量：无命中的页共用同一引用，避免每次渲染都触发重算。 */
export const NO_SEARCH_MARKS: PdfSearchMark[] = [];

/**
 * 本页搜索命中矩形组（spec 2026-09-24 in-book-search）：与 usePdfHighlights 同法——textLayer 就绪后
 * 把页内偏移经 Range.getClientRects() 转成相对页容器的矩形；越界的命中画不出即跳过。
 */
export function usePdfSearchHighlights(
  marks: PdfSearchMark[],
  textLayer: HTMLDivElement | null,
  ready: boolean,
): PdfSearchRect[] {
  const [rects, setRects] = useState<PdfSearchRect[]>([]);
  useEffect(() => {
    if (!ready || !textLayer || marks.length === 0) {
      setRects([]);
      return;
    }
    const container = textLayer.getBoundingClientRect();
    const out: PdfSearchRect[] = [];
    for (const m of marks) {
      const range = rangeFromOffsets(textLayer, m.start, m.end);
      if (!range) continue;
      for (const rect of relativeRects(range.getClientRects(), container)) {
        out.push({ rect, active: m.active });
      }
    }
    setRects(out);
  }, [marks, textLayer, ready]);
  return rects;
}
