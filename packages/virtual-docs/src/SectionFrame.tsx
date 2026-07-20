import { useEffect, useMemo, useRef } from "react";
import { toViewportRect, type ViewportRect } from "./geometry";
import { classifyLink } from "./link-target";

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
  /** 悬停带笔记的高亮 mark（class 含 anno-noted）时回调；rect 为视口坐标。 */
  onHighlightHover?: (annoId: string, rect: ViewportRect) => void;
  /** 离开带笔记高亮（移到非 noted 区域 / 移出 iframe）时回调。 */
  onHighlightLeave?: () => void;
  /** 变化即对已加载文档重跑 decorate（标注增删改后由 VirtualDocs 递增）。 */
  decorateNonce?: number;
  /** iframe 内任意 mousedown 时回调；同源 iframe 内部事件不冒泡到父文档，消费方借此关闭浮层。 */
  onContentMouseDown?: () => void;
  /** iframe 内普通指针操作；父滚动容器收不到这些跨文档事件。 */
  onUserNavigation?: () => void;
  /** iframe 内明确会推动阅读位置的输入；用于渐进开放前置 section。 */
  onUserScrollNavigation?: () => void;
  /** 点 iframe 内站内 <a>（相对路径 / #fragment）时回调；消费方据此 resolve 到 section+anchor 跳转。 */
  onInternalLink?: (e: { index: number; href: string }) => void;
  /** 点 iframe 内外链（http/https/mailto）时回调；消费方开系统浏览器。 */
  onExternalLink?: (url: string) => void;
  /** 就绪前的占位高度（来自 VirtualDocs 测高缓存）；避免就绪前 0/默认高度造成跳变。 */
  estimatedHeight?: number;
  /** 内容就绪、测得稳定高度后回调（index, heightPx），供 VirtualDocs 写测高缓存。 */
  onMeasured?: (index: number, height: number) => void;
}

const STYLE_ID = "vd-style";

/** 等待图片/字体就绪的整体超时（ms），到时即用当前高度兜底，绝不无限等。 */
const READY_TIMEOUT_MS = 2000;
/** 就绪后真实内容变化（如改字号偏好）重测的 debounce（ms）。 */
const RO_DEBOUNCE_MS = 100;

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
  onHighlightHover,
  onHighlightLeave,
  decorateNonce,
  onContentMouseDown,
  onUserNavigation,
  onUserScrollNavigation,
  estimatedHeight,
  onMeasured,
  onInternalLink,
  onExternalLink,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  // 用 ref 持最新回调，避免回调身份变化触发 effect 重挂
  const cbRef = useRef({
    onSelect,
    onSelectionCleared,
    decorate,
    onHighlightClick,
    onHighlightHover,
    onHighlightLeave,
    onContentMouseDown,
    onUserNavigation,
    onUserScrollNavigation,
    estimatedHeight,
    onMeasured,
    onInternalLink,
    onExternalLink,
  });
  cbRef.current = {
    onSelect,
    onSelectionCleared,
    decorate,
    onHighlightClick,
    onHighlightHover,
    onHighlightLeave,
    onContentMouseDown,
    onUserNavigation,
    onUserScrollNavigation,
    estimatedHeight,
    onMeasured,
    onInternalLink,
    onExternalLink,
  };
  const docRef = useRef<Document | null>(null);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    let ro: ResizeObserver | undefined;
    let roTimer: ReturnType<typeof setTimeout> | undefined;
    let readyTimeout: ReturnType<typeof setTimeout> | undefined;
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
    // (clientX, clientY 为 iframe 视口坐标) 是否落在当前非塌缩选区内。
    const pointInSelection = (x: number, y: number): boolean => {
      if (!doc) return false;
      const sel = doc.getSelection();
      if (!sel || sel.isCollapsed || sel.rangeCount === 0) return false;
      try {
        const caret = (
          doc as Document & { caretRangeFromPoint?(x: number, y: number): Range | null }
        ).caretRangeFromPoint?.(x, y);
        return !!caret && sel.getRangeAt(0).isPointInRange(caret.startContainer, caret.startOffset);
      } catch {
        return false;
      }
    };
    const onContentDown = (e: MouseEvent) => {
      // 点在已有选区内部：阻止默认塌缩、保留选区，让随后的 mouseup 照常触发 onSelect
      // （滚动隐藏工具栏后，点回选区即在新位置重弹工具栏）。点在选区外则照常上报（关闭浮层）。
      if (pointInSelection(e.clientX, e.clientY)) {
        e.preventDefault();
        return;
      }
      cbRef.current.onContentMouseDown?.();
    };
    const onUserNavigationInput = () => cbRef.current.onUserNavigation?.();
    const onUserScrollNavigationInput = () => cbRef.current.onUserScrollNavigation?.();
    // 上次命中的带笔记高亮 id（仅在变化时上报，减少无谓 store 写入与重渲染）。
    let lastNotedId: string | null = null;
    const reportLeaveIfNeeded = () => {
      if (lastNotedId !== null) {
        lastNotedId = null;
        cbRef.current.onHighlightLeave?.();
      }
    };
    // 悬停在选区上 → 手型；并检测带笔记高亮 → 上报 hover/leave。
    const onContentMove = (e: MouseEvent) => {
      if (!doc?.body) return;
      const cursor = pointInSelection(e.clientX, e.clientY) ? "pointer" : "";
      if (doc.body.style.cursor !== cursor) doc.body.style.cursor = cursor;
      const mark = (e.target as Element | null)?.closest?.("mark.anno-noted") as HTMLElement | null;
      const id = mark?.getAttribute("data-anno-id") ?? null;
      if (id === lastNotedId) return;
      lastNotedId = id;
      if (id && mark) {
        const r = mark.getBoundingClientRect();
        const fr = iframe.getBoundingClientRect();
        cbRef.current.onHighlightHover?.(id, toViewportRect(r, fr));
      } else {
        cbRef.current.onHighlightLeave?.();
      }
    };
    // 鼠标移出 iframe（含移向主文档的卡片）→ 上报 leave，起关闭窗口（移到卡片会被 enterCard 取消）。
    const onContentOut = (e: MouseEvent) => {
      // relatedTarget 为 null = 离开 iframe 文档边界。
      if (e.relatedTarget === null) reportLeaveIfNeeded();
    };
    const onLinkClick = (e: MouseEvent) => {
      const a = (e.target as Element | null)?.closest?.("a[href]") as HTMLAnchorElement | null;
      if (!a) return;
      // 取原始 href 属性（非 a.href——后者会被 about:srcdoc 解析成绝对无效地址）。
      const raw = a.getAttribute("href") ?? "";
      const target = classifyLink(raw);
      if (!target) {
        e.preventDefault(); // 裸 "#"：阻止默认导航即可，不白屏
        return;
      }
      e.preventDefault(); // 关键：阻止 iframe 自身导航（否则白屏）
      if (target.type === "external") cbRef.current.onExternalLink?.(target.url);
      else cbRef.current.onInternalLink?.({ index, href: target.href });
    };
    const detach = () => {
      ro?.disconnect();
      ro = undefined;
      // 清理可能挂起的 debounce / 超时计时器：virtuoso 回收 item DOM 后，
      // 已排期的 measure 会把错高度写进被复用的 iframe（正是要消除的跳变）。
      if (roTimer) {
        clearTimeout(roTimer);
        roTimer = undefined;
      }
      if (readyTimeout) {
        clearTimeout(readyTimeout);
        readyTimeout = undefined;
      }
      doc?.removeEventListener("mouseup", onMouseUp);
      doc?.removeEventListener("selectionchange", onSelChange);
      doc?.removeEventListener("click", onAnnoClick);
      doc?.removeEventListener("click", onLinkClick);
      doc?.removeEventListener("mousedown", onContentDown);
      doc?.removeEventListener("wheel", onUserScrollNavigationInput);
      doc?.removeEventListener("touchstart", onUserScrollNavigationInput);
      doc?.removeEventListener("pointerdown", onUserNavigationInput);
      doc?.removeEventListener("keydown", onUserScrollNavigationInput);
      doc?.removeEventListener("mousemove", onContentMove);
      doc?.removeEventListener("mouseout", onContentOut);
      if (doc?.body) doc.body.style.cursor = "";
      reportLeaveIfNeeded();
      doc = null;
      docRef.current = null;
    };
    const onLoad = () => {
      detach();
      doc = iframe.contentDocument;
      if (!doc) return;
      const d = doc; // 窄化给闭包
      // 占位：就绪前先用估高，避免 iframe 默认高度造成的跳变。
      iframe.style.height = `${cbRef.current.estimatedHeight ?? 0}px`;

      const measure = () => {
        iframe.style.height = `${d.documentElement.scrollHeight}px`;
      };
      let settled = false;
      const reportStable = () => {
        if (settled) return;
        settled = true;
        const h = d.documentElement.scrollHeight;
        iframe.style.height = `${h}px`;
        cbRef.current.onMeasured?.(index, h);
        // 就绪后才挂 ResizeObserver，服务后续真实内容变化（如改字号偏好），debounce 抑抖。
        ro = new ResizeObserver(() => {
          if (roTimer) clearTimeout(roTimer);
          roTimer = setTimeout(measure, RO_DEBOUNCE_MS);
        });
        ro.observe(d.documentElement);
      };

      // 等所有图片 decode + 字体就绪；整体超时兜底，绝不无限等。
      const imgs = Array.from(d.images);
      const ready = Promise.all([
        ...imgs.map((img) => img.decode().catch(() => undefined)),
        d.fonts?.ready ?? Promise.resolve(),
      ]).then(() => undefined);
      const timeout = new Promise<void>((res) => {
        readyTimeout = setTimeout(res, READY_TIMEOUT_MS);
      });
      void Promise.race([ready, timeout]).then(reportStable);

      doc.addEventListener("mouseup", onMouseUp);
      doc.addEventListener("selectionchange", onSelChange);
      docRef.current = doc;
      cbRef.current.decorate?.(index, doc);
      doc.addEventListener("click", onAnnoClick);
      doc.addEventListener("click", onLinkClick);
      doc.addEventListener("mousedown", onContentDown);
      doc.addEventListener("wheel", onUserScrollNavigationInput, { passive: true });
      doc.addEventListener("touchstart", onUserScrollNavigationInput, { passive: true });
      doc.addEventListener("pointerdown", onUserNavigationInput);
      doc.addEventListener("keydown", onUserScrollNavigationInput);
      doc.addEventListener("mousemove", onContentMove);
      doc.addEventListener("mouseout", onContentOut);
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
      // height 初值必须随首次渲染就位：iframe 从挂载到 load 事件之间若无 height，会以 Chromium
      // 默认 150px 参与布局——视口上方的 section 重挂时高度瞬时塌缩再恢复，virtuoso 的 scrollTop
      // 补偿与用户滚动竞争，正是「向上翻大跳」的主根因。load 后由 measure 手写真高接管（React
      // 仅在 estimatedHeight 值变化时重写该属性，且届时缓存值已等于真高，不会回退）。
      style={{ width: "100%", border: 0, display: "block", height: estimatedHeight ?? 0 }}
    />
  );
}
