import { useEffect, useMemo, useRef } from "react";
import { toViewportRect, type ViewportRect } from "./geometry";

export interface SectionSelectEvent {
  index: number;
  range: Range;
  doc: Document;
  rect: ViewportRect;
  text: string;
}

interface Props {
  index: number;
  html: string;
  styleCss?: string;
  onSelect?: (e: SectionSelectEvent) => void;
  onSelectionCleared?: () => void;
  /** iframe 内容加载后（及 decorateNonce 变化时）回调，供消费方在文档上贴装饰（如高亮 mark）。 */
  decorate?: (index: number, doc: Document) => void;
  /** 点击带 data-anno-id 的装饰元素时回调（rect 为视口坐标）。 */
  onHighlightClick?: (annoId: string, rect: ViewportRect) => void;
  /** 变化即对已加载文档重跑 decorate（标注增删改后由 VirtualDocs 递增）。 */
  decorateNonce?: number;
  /** iframe 内任意 mousedown 时回调；同源 iframe 内部事件不冒泡到父文档，消费方借此关闭浮层。 */
  onContentMouseDown?: () => void;
}

const STYLE_ID = "vd-style";

/** 把（可能是片段或完整文档的）HTML 包成带注入 style 的完整文档串。 */
function buildSrcDoc(html: string, styleCss?: string): string {
  const style = `<style id="${STYLE_ID}">${styleCss ?? ""}</style>`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${style}`);
  return `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${html}</body></html>`;
}

export function SectionFrame({
  index,
  html,
  styleCss,
  onSelect,
  onSelectionCleared,
  decorate,
  onHighlightClick,
  decorateNonce,
  onContentMouseDown,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // 用 ref 持最新回调，避免回调身份变化触发 effect 重挂
  const cbRef = useRef({
    onSelect,
    onSelectionCleared,
    decorate,
    onHighlightClick,
    onContentMouseDown,
  });
  cbRef.current = { onSelect, onSelectionCleared, decorate, onHighlightClick, onContentMouseDown };
  const docRef = useRef<Document | null>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let ro: ResizeObserver | undefined;
    let doc: Document | null = null;

    const onMouseUp = () => {
      if (!doc) return;
      const sel = doc.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
      const text = sel.toString().trim();
      if (!text) return;
      const range = sel.getRangeAt(0);
      const r = range.getBoundingClientRect();
      const fr = iframe.getBoundingClientRect();
      cbRef.current.onSelect?.({ index, range, doc, rect: toViewportRect(r, fr), text });
    };
    const onSelChange = () => {
      if (!doc) return;
      const sel = doc.getSelection();
      if (!sel || sel.isCollapsed) cbRef.current.onSelectionCleared?.();
    };
    const onAnnoClick = (e: MouseEvent) => {
      if (!doc) return;
      const el = (e.target as Element | null)?.closest?.("[data-anno-id]") as HTMLElement | null;
      if (!el) return;
      const id = el.getAttribute("data-anno-id");
      if (!id) return;
      const r = el.getBoundingClientRect();
      const fr = iframe.getBoundingClientRect();
      cbRef.current.onHighlightClick?.(id, toViewportRect(r, fr));
    };
    const onContentDown = (e: MouseEvent) => {
      if (!doc) return;
      // 点在已有非塌缩选区内部：阻止默认塌缩、保留选区，让随后的 mouseup 照常触发 onSelect
      // （滚动隐藏工具栏后，点回选区即在新位置重弹工具栏）。点在选区外则照常上报（关闭浮层）。
      const sel = doc.getSelection();
      if (sel && !sel.isCollapsed && sel.rangeCount > 0) {
        try {
          const caret = (
            doc as Document & {
              caretRangeFromPoint?(x: number, y: number): Range | null;
            }
          ).caretRangeFromPoint?.(e.clientX, e.clientY);
          if (caret && sel.getRangeAt(0).isPointInRange(caret.startContainer, caret.startOffset)) {
            e.preventDefault();
            return;
          }
        } catch {
          /* caretRangeFromPoint/isPointInRange 不可用则按选区外处理 */
        }
      }
      cbRef.current.onContentMouseDown?.();
    };
    const detach = () => {
      ro?.disconnect();
      ro = undefined;
      doc?.removeEventListener("mouseup", onMouseUp);
      doc?.removeEventListener("selectionchange", onSelChange);
      doc?.removeEventListener("click", onAnnoClick);
      doc?.removeEventListener("mousedown", onContentDown);
      doc = null;
      docRef.current = null;
    };
    const onLoad = () => {
      detach();
      doc = iframe.contentDocument;
      if (!doc) return;
      const measure = () => {
        if (doc) iframe.style.height = `${doc.documentElement.scrollHeight}px`;
      };
      measure();
      ro = new ResizeObserver(measure);
      ro.observe(doc.documentElement);
      doc.addEventListener("mouseup", onMouseUp);
      doc.addEventListener("selectionchange", onSelChange);
      docRef.current = doc;
      cbRef.current.decorate?.(index, doc);
      doc.addEventListener("click", onAnnoClick);
      doc.addEventListener("mousedown", onContentDown);
    };

    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      detach();
    };
  }, [index]);

  useEffect(() => {
    if (docRef.current) cbRef.current.decorate?.(index, docRef.current);
  }, [decorateNonce, index]);

  const srcDoc = useMemo(() => buildSrcDoc(html, styleCss), [html, styleCss]);

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-same-origin"
      title={`section-${index}`}
      scrolling="no"
      style={{ width: "100%", border: 0, display: "block" }}
    />
  );
}
