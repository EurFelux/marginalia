// 在静态正文上用浏览器原生选区还原「渲染层选区提取」：选中文本 + 触及段落（含跨段）的
// 前1/当前/后1 段上下文 + 选区包围盒（供浮动工具栏定位）。映射为 @renderer/types 的 SelectionInfo。

import { useEffect, type RefObject } from "react";
import type { SelectionInfo } from "@renderer/types";

function paragraphOf(node: Node): HTMLElement | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  return el?.closest("[data-paragraph]") ?? null;
}
function textOf(el: Element | null): string {
  return el?.textContent?.trim() ?? "";
}

export function useSelection(
  containerRef: RefObject<HTMLElement | null>,
  onSelect: (info: SelectionInfo | null) => void,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    const compute = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) {
        onSelect(null);
        return;
      }
      const text = sel.toString().trim();
      if (!text) {
        onSelect(null);
        return;
      }
      const range = sel.getRangeAt(0);
      if (!container.contains(range.commonAncestorContainer)) return;

      const startPara = paragraphOf(range.startContainer);
      const endPara = paragraphOf(range.endContainer);
      const anchorPara = startPara ?? endPara;
      if (!anchorPara) {
        onSelect(null);
        return;
      }

      const all = Array.from(container.querySelectorAll<HTMLElement>("[data-paragraph]"));
      const i1 = all.indexOf(startPara ?? anchorPara);
      const i2 = all.indexOf(endPara ?? anchorPara);
      const lo = Math.min(i1, i2);
      const hi = Math.max(i1, i2);

      const current = all
        .slice(lo, hi + 1)
        .map(textOf)
        .filter(Boolean)
        .join("\n\n");
      const before = lo > 0 ? textOf(all[lo - 1]) : "";
      const after = hi < all.length - 1 ? textOf(all[hi + 1]) : "";

      const r = range.getBoundingClientRect();
      onSelect({
        selectionText: text,
        paragraphBefore: before || null,
        paragraphCurrent: current,
        paragraphAfter: after || null,
        rect: { x: r.left, y: r.top, width: r.width, height: r.height },
      });
    };

    // mouseup 后选区才稳定，下一帧再算
    const onMouseUp = () => window.setTimeout(compute, 0);
    // 选区被清空（点别处）→ 通知清空
    const onSelectionChange = () => {
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed) onSelect(null);
    };

    document.addEventListener("mouseup", onMouseUp);
    document.addEventListener("selectionchange", onSelectionChange);
    return () => {
      document.removeEventListener("mouseup", onMouseUp);
      document.removeEventListener("selectionchange", onSelectionChange);
    };
  }, [containerRef, onSelect]);
}
