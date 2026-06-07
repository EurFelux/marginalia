import type { SelectionInfo } from "@renderer/types";
import { makePdfLocatorRange } from "./pdf-locator";

/** 上下文窗口半径（字符）：选区前后各取这么多页内文本充当「周围上下文」（spec §6——PDF 无段落 DOM）。 */
const CONTEXT_WINDOW = 300;

/**
 * 求 (node, offsetInNode) 在 root 内扁平文本流中的偏移。
 * 坐标空间 = root 内 text node 按文档序拼接（textLayer 的 span 流即 getTextContent items
 * 顺序，不含 pdfjs 的 EOL 合成换行）——与 pdf-locator range、（P3）高亮绘制同一空间。
 * node 不在 root 内或不是 text node（如 triple-click 的元素容器）→ null；
 * 调用方把 locatorRange 置 null：问 AI 不受影响，只是该选区不可锚定标注。
 */
export function flatOffsetOf(root: Node, node: Node, offsetInNode: number): number | null {
  if (node.nodeType !== Node.TEXT_NODE) return null;
  let acc = 0;
  const walker = (root.ownerDocument ?? document).createTreeWalker(root, NodeFilter.SHOW_TEXT);
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    if (t === node) return acc + offsetInNode;
    acc += (t.textContent ?? "").length;
  }
  return null;
}

/**
 * (clientX, clientY) 是否落在当前非塌缩 DOM 选区内。
 * caretRangeFromPoint + isPointInRange = 字符级命中（跨行选区的锯齿边界也精确），
 * 与 virtual-docs SectionFrame 的 pointInSelection 同款（那边作用于 iframe doc）。
 * 消费方：mousedown 守卫（点选区→保留并重弹工具栏）与 hover cursor。
 */
export function pointInDomSelection(x: number, y: number): boolean {
  const sel = document.getSelection();
  if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
  try {
    const caret = (
      document as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }
    ).caretRangeFromPoint?.(x, y);
    return !!caret && sel.getRangeAt(0).isPointInRange(caret.startContainer, caret.startOffset);
  } catch {
    return false;
  }
}

export interface PdfSelectionArgs {
  page: number; // 1-based
  /** 该页 textLayer 的扁平文本（element.textContent）。 */
  pageStr: string;
  /** 页内偏移；跨页选区或元素容器时为 null。 */
  start: number | null;
  end: number | null;
  selectionText: string;
  rect: { x: number; y: number; width: number; height: number };
}

/** 组装 PDF 选区的 SelectionInfo：「周围上下文」用选区前后字符窗口替代段落（spec §6）。 */
export function buildPdfSelectionInfo(a: PdfSelectionArgs): SelectionInfo {
  const s = a.start ?? 0;
  const e = a.end ?? Math.min(s + a.selectionText.length, a.pageStr.length);
  const windowText = a.pageStr
    .slice(Math.max(0, s - CONTEXT_WINDOW), Math.min(a.pageStr.length, e + CONTEXT_WINDOW))
    .trim();
  return {
    selectionText: a.selectionText,
    paragraphBefore: null,
    paragraphCurrent: windowText.length > 0 ? windowText : a.selectionText,
    paragraphAfter: null,
    rect: a.rect,
    locatorRange:
      a.start != null && a.end != null && a.end > a.start
        ? makePdfLocatorRange({ page: a.page, start: a.start, end: a.end })
        : null,
  };
}
