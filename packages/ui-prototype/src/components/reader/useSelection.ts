// 在静态正文上用浏览器原生选区还原“渲染层选区提取”：取选中文本 + 触及段落（含跨段/跨章）
// 的前1/后1 段上下文 + 触及章节集合 + 指针视口坐标。这套 DOM 取段逻辑日后可直接复用到渲染层。

import { useEffect, type RefObject } from "react";
import type { SelectionInfo } from "#/mock/types";

function closestEl(node: Node, selector: string): HTMLElement | null {
  const el = node.nodeType === Node.ELEMENT_NODE ? (node as HTMLElement) : node.parentElement;
  return el?.closest(selector) ?? null;
}

function textOf(el: Element | null): string {
  return el?.textContent?.trim() ?? "";
}

function paragraphOf(node: Node): HTMLElement | null {
  return closestEl(node, "[data-paragraph]");
}

function chapterIdOf(el: Element): string {
  return el.closest("[data-chapter]")?.getAttribute("data-chapter") ?? "";
}

// 段落内字符偏移：从段首到 (container, offset) 的文本长度
function offsetInPara(para: Element, container: Node, offset: number): number {
  const r = document.createRange();
  r.selectNodeContents(para);
  try {
    r.setEnd(container, offset);
  } catch {
    return para.textContent?.length ?? 0;
  }
  return r.toString().length;
}

export function useSelection(
  containerRef: RefObject<HTMLElement | null>,
  onSelect: (info: SelectionInfo | null) => void,
): void {
  useEffect(() => {
    const container = containerRef.current;
    if (!container) return;

    // px/py = 划词结束时的指针视口坐标（mouseup），用于工具栏贴合指针
    const compute = (px: number, py: number) => {
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

      // 用起始/结束容器分别定位首段/末段（跨段/跨章时公共祖先不是段落）
      const startPara = paragraphOf(range.startContainer);
      const endPara = paragraphOf(range.endContainer);
      const anchorPara = startPara ?? endPara;
      if (!anchorPara) {
        onSelect(null);
        return;
      }

      // 扁平化容器内全部段落，用首/末段下标切片 → 天然支持跨段、跨章
      const all = Array.from(container.querySelectorAll<HTMLElement>("[data-paragraph]"));
      const idxs = [startPara, endPara].map((p) => (p ? all.indexOf(p) : -1)).filter((i) => i >= 0);
      const span = idxs.length ? idxs : [all.indexOf(anchorPara)];
      const lo = Math.min(...span);
      const hi = Math.max(...span);

      const selected = all.slice(lo, hi + 1);
      const chapterIds = [...new Set(selected.map(chapterIdOf).filter(Boolean))];
      // 周围上下文 = 选中段落 + 前1/后1 段（逐字）
      const ctx = all.slice(Math.max(0, lo - 1), hi + 2);

      // 选区按段拆成字符区间（用于落标注 / 渲染高亮）
      const ranges = selected
        .map((para) => {
          const full = para.textContent ?? "";
          const s =
            para === startPara ? offsetInPara(para, range.startContainer, range.startOffset) : 0;
          const e =
            para === endPara
              ? offsetInPara(para, range.endContainer, range.endOffset)
              : full.length;
          return {
            chapterId: chapterIdOf(para),
            paragraphIndex: Number(para.dataset.pidx ?? "-1"),
            start: Math.min(s, e),
            end: Math.max(s, e),
          };
        })
        .filter((r) => r.paragraphIndex >= 0 && r.end > r.start);

      onSelect({
        selectionText: text,
        paragraphText: ctx.map(textOf).filter(Boolean).join("\n\n"),
        chapterIds,
        anchor: { x: px, y: py },
        ranges,
      });
    };

    // mouseup 后选区才稳定；下一帧再算，并记下指针落点
    const onMouseUp = (e: MouseEvent) => {
      const { clientX, clientY } = e;
      window.setTimeout(() => compute(clientX, clientY), 0);
    };
    // 选区被清空（点别处）→ 隐藏工具栏
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
