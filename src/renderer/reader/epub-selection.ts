import type { SectionSelectEvent } from "@marginalia/virtual-docs";
import type { SelectionInfo } from "../types";

const BLOCK_TAGS = new Set([
  "P",
  "DIV",
  "LI",
  "BLOCKQUOTE",
  "SECTION",
  "ARTICLE",
  "ASIDE",
  "H1",
  "H2",
  "H3",
  "H4",
  "H5",
  "H6",
  "PRE",
  "FIGCAPTION",
  "TD",
  "TH",
]);

/** 取 node 最近的块级祖先元素（含自身）。 */
function blockAncestor(node: Node): Element | null {
  let el: Node | null = node.nodeType === Node.ELEMENT_NODE ? node : node.parentNode;
  while (el && el.nodeType === Node.ELEMENT_NODE) {
    if (BLOCK_TAGS.has((el as Element).tagName)) return el as Element;
    el = el.parentNode;
  }
  return null;
}

/** 相邻块级兄弟的文本（跳过空白文本节点）。 */
function siblingBlockText(el: Element, dir: "previous" | "next"): string | null {
  let sib: Element | null = dir === "previous" ? el.previousElementSibling : el.nextElementSibling;
  while (sib) {
    const t = (sib.textContent ?? "").trim();
    if (t.length > 0) return t;
    sib = dir === "previous" ? sib.previousElementSibling : sib.nextElementSibling;
  }
  return null;
}

/**
 * 把包的 onSelect 事件转成 SelectionInfo（AI 契约老形状 + cfiRange）。
 * 块级取段：当前段 = 选区**起点**的最近块级祖先文本；前/后段 = 其相邻块级兄弟。
 * 跨块选区（起点、终点在不同块）时不做精确切分——`paragraphCurrent` 仍取起点块，
 * 终点块自然落入 `paragraphAfter`；这是 best-effort 语义，足够给 AI 上下文。
 * 提取失败（取不到块级祖先）时退化为「只发选中文本」（绝不静默吞掉提问）。
 */
export function sectionSelectToSelectionInfo(
  e: SectionSelectEvent,
  cfiRange: string | null,
): SelectionInfo {
  const block = blockAncestor(e.range.startContainer);
  const paragraphCurrent = (block?.textContent ?? e.text).trim();
  const paragraphBefore = block ? siblingBlockText(block, "previous") : null;
  const paragraphAfter = block ? siblingBlockText(block, "next") : null;
  return {
    selectionText: e.text,
    paragraphBefore,
    paragraphCurrent: paragraphCurrent.length > 0 ? paragraphCurrent : e.text,
    paragraphAfter,
    rect: e.rect, // 包已平移为 viewport 坐标（ViewportRect 与 SelectionInfo.rect 同形）
    cfiRange,
  };
}
