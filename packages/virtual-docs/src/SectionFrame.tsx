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
}

const STYLE_ID = "vd-style";

/** 把（可能是片段或完整文档的）HTML 包成带注入 style 的完整文档串。 */
function buildSrcDoc(html: string, styleCss?: string): string {
  const style = `<style id="${STYLE_ID}">${styleCss ?? ""}</style>`;
  if (/<head[\s>]/i.test(html)) return html.replace(/<head([^>]*)>/i, `<head$1>${style}`);
  return `<!doctype html><html><head><meta charset="utf-8">${style}</head><body>${html}</body></html>`;
}

export function SectionFrame({ index, html, styleCss, onSelect, onSelectionCleared }: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // 用 ref 持最新回调，避免回调身份变化触发 effect 重挂
  const cbRef = useRef({ onSelect, onSelectionCleared });
  cbRef.current = { onSelect, onSelectionCleared };

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
    const detach = () => {
      ro?.disconnect();
      ro = undefined;
      doc?.removeEventListener("mouseup", onMouseUp);
      doc?.removeEventListener("selectionchange", onSelChange);
      doc = null;
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
    };

    iframe.addEventListener("load", onLoad);
    return () => {
      iframe.removeEventListener("load", onLoad);
      detach();
    };
  }, [index]);

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
