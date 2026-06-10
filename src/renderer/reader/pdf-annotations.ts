import type { AnnotationDto, AnnotationStyle } from "@shared/annotations";
import { parsePdfLocatorRange } from "./pdf-locator";
import { hasNote } from "./highlight";

/** 单页标注（绘制输入）：locatorRange 解析后的页内偏移 + 视觉属性。 */
export interface PdfPageAnno {
  id: string;
  style: AnnotationStyle;
  hasNote: boolean;
  start: number;
  end: number;
}

/**
 * 把扁平偏移区间还原成 root 内的 DOM Range（flatOffsetOf 的逆；同一坐标空间：
 * textLayer text node 按文档序拼接，见 pdf-selection.ts 注记）。
 * 偏移越界（如 pdfjs 升级改变文本提取结果）或空区间 → null，调用方跳过绘制——
 * selectedText 重锚定兜底 v1 不实现（spec §11）。
 */
export function rangeFromOffsets(root: Node, start: number, end: number): Range | null {
  if (start < 0 || end <= start) return null;
  const doc = root.ownerDocument ?? document;
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let acc = 0;
  let startNode: Node | null = null;
  let startOffset = 0;
  let endNode: Node | null = null;
  let endOffset = 0;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const len = (t.textContent ?? "").length;
    if (startNode === null && acc + len > start) {
      startNode = t;
      startOffset = start - acc;
    }
    if (acc + len >= end) {
      endNode = t;
      endOffset = end - acc;
      break;
    }
    acc += len;
  }
  if (!startNode || !endNode) return null;
  const range = doc.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  return range;
}

/** 标注按页分组（绘制分发用）。非 pdf locator（防御）与解析失败一律静默跳过。 */
export function pdfAnnosByPage(annos: AnnotationDto[]): Map<number, PdfPageAnno[]> {
  const map = new Map<number, PdfPageAnno[]>();
  for (const a of annos) {
    const r = parsePdfLocatorRange(a.locatorRange);
    if (!r) continue;
    const arr = map.get(r.page) ?? [];
    arr.push({
      id: a.id,
      style: a.style,
      hasNote: hasNote(a.note),
      start: r.start,
      end: r.end,
    });
    map.set(r.page, arr);
  }
  return map;
}

/** PDF 标注阅读序排序键（页主序、页内偏移次序）；非 pdf locator → null（走 CFI 路径）。 */
export function pdfOrderKey(locator: string): number | null {
  const r = parsePdfLocatorRange(locator);
  return r ? r.page * 1_000_000 + Math.min(r.start, 999_999) : null;
}

/** 相对容器坐标的 overlay 矩形。 */
export interface OverlayRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

/** 视口坐标矩形 → 相对容器坐标；丢弃 <1px 的零尺寸碎片（getClientRects 的折行渣）。 */
export function relativeRects(
  rects: Iterable<{ x: number; y: number; width: number; height: number }>,
  container: { x: number; y: number },
): OverlayRect[] {
  const out: OverlayRect[] = [];
  for (const r of rects) {
    if (r.width < 1 || r.height < 1) continue;
    out.push({ left: r.x - container.x, top: r.y - container.y, width: r.width, height: r.height });
  }
  return out;
}
