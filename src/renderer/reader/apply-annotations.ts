import type { AnnotationDto } from "@shared/annotations";
import type { EpubBook } from "./epub-book";

/** 移除文档内全部高亮 mark（用其文本内容替换 mark，再合并相邻文本节点）。 */
export function clearAnnoMarks(doc: Document): void {
  const marks = Array.from(doc.querySelectorAll("mark.anno"));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

/** 把一个 Range（可能跨多个文本节点）按文本节点逐段包成 <mark>。 */
function wrapRange(range: Range, doc: Document, className: string, annoId: string): void {
  const root = range.commonAncestorContainer;
  const walker = doc.createTreeWalker(
    root.nodeType === Node.ELEMENT_NODE
      ? root
      : (root.parentNode ?? doc.body ?? doc.documentElement),
    NodeFilter.SHOW_TEXT,
  );
  const textNodes: Text[] = [];
  let n = walker.nextNode();
  while (n) {
    const t = n as Text;
    if (range.intersectsNode(t) && (t.textContent ?? "").length > 0) textNodes.push(t);
    n = walker.nextNode();
  }
  for (const textNode of textNodes) {
    const start = textNode === range.startContainer ? range.startOffset : 0;
    const end =
      textNode === range.endContainer ? range.endOffset : (textNode.textContent ?? "").length;
    if (end <= start) continue;
    const sub = doc.createRange();
    sub.setStart(textNode, start);
    sub.setEnd(textNode, end);
    const mark = doc.createElement("mark");
    mark.className = className;
    mark.setAttribute("data-anno-id", annoId);
    try {
      sub.surroundContents(mark); // 单文本节点内的子 Range 可安全 surround
    } catch {
      /* 极端结构跳过该段（best-effort） */
    }
  }
}

/**
 * 把属于第 index 个 section 的标注渲染为高亮 mark。先清旧 mark（幂等），
 * 再按 `book.indexOfCfi(cfiRange)===index` 过滤、`book.rangeFromCfi` 取 Range 后包裹。
 * toRange 失败（CFI 失效）跳过该条（best-effort），它仍在侧栏列表（快照展示）。
 */
export function applyAnnotations(
  book: EpubBook,
  annotations: AnnotationDto[],
  index: number,
  doc: Document,
): void {
  clearAnnoMarks(doc);
  for (const a of annotations) {
    if (book.indexOfCfi(a.cfiRange) !== index) continue;
    const range = book.rangeFromCfi(a.cfiRange, doc);
    if (!range) continue;
    const noted = a.note.trim().length > 0 ? " anno-noted" : "";
    wrapRange(range, doc, `anno anno-${a.style}${noted}`, a.id);
  }
}
