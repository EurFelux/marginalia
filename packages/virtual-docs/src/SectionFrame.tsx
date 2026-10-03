import { useEffect, useMemo, useRef } from "react";
import { applyPaintCss, buildSrcDoc } from "./frame-doc";
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
  /** 只影响绘制的 CSS（如明暗配色）：变化时原地替换，不重载 iframe（见 VirtualDocsProps.paintCss）。 */
  paintCss?: string;
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
  /** iframe 内明确会推动阅读位置的输入；用于渐进开放前置 section。事件随附以判别滚动方向。 */
  onUserScrollNavigation?: (e: Event) => void;
  /** 点 iframe 内站内 <a>（相对路径 / #fragment）时回调；消费方据此 resolve 到 section+anchor 跳转。 */
  onInternalLink?: (e: { index: number; href: string }) => void;
  /** 点 iframe 内外链（http/https/mailto）时回调；消费方开系统浏览器。 */
  onExternalLink?: (url: string) => void;
  /** iframe 内 keydown（同源 iframe 的键盘事件不冒泡到父文档）；消费方借此实现阅读器快捷键。 */
  onKeyDown?: (e: KeyboardEvent) => void;
  /** 就绪前的占位高度（来自 VirtualDocs 测高缓存）；避免就绪前 0/默认高度造成跳变。 */
  estimatedHeight?: number;
  /** 内容就绪测得稳定高度、以及之后重测出不同高度时回调（index, heightPx），供 VirtualDocs 写测高缓存。 */
  onMeasured?: (index: number, height: number) => void;
  /** 写入 iframe 高度（VirtualDocs 借此暂缓视口上方 section 的高度变化）；不传则直接写。 */
  writeHeight?: (index: number, iframe: HTMLIFrameElement, px: number) => void;
}

/** 等待图片/字体就绪的整体超时（ms），到时即用当前高度兜底，绝不无限等。 */
const READY_TIMEOUT_MS = 2000;
/** 就绪后真实内容变化（如改字号偏好）重测的 debounce（ms）。 */
const RO_DEBOUNCE_MS = 100;

export function SectionFrame({
  index,
  html,
  styleCss,
  paintCss,
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
  writeHeight,
  onInternalLink,
  onExternalLink,
  onKeyDown,
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
    writeHeight,
    onInternalLink,
    onExternalLink,
    onKeyDown,
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
    writeHeight,
    onInternalLink,
    onExternalLink,
    onKeyDown,
  };
  const docRef = useRef<Document | null>(null);
  // srcDoc 构建时取最新 paintCss，但不把它列为重建依赖：换主题只走下方 applyPaintCss 原地更新。
  const paintCssRef = useRef(paintCss);
  paintCssRef.current = paintCss;

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
    const onDocKeyDown = (e: KeyboardEvent) => cbRef.current.onKeyDown?.(e);
    const onUserScrollNavigationInput = (e: Event) => cbRef.current.onUserScrollNavigation?.(e);
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
      doc?.removeEventListener("keydown", onDocKeyDown);
      doc?.removeEventListener("mousemove", onContentMove);
      doc?.removeEventListener("mouseout", onContentOut);
      if (doc?.body) doc.body.style.cursor = "";
      reportLeaveIfNeeded();
      doc = null;
      docRef.current = null;
    };
    const setHeight = (px: number) => {
      const write = cbRef.current.writeHeight;
      if (write) write(index, iframe, px);
      else iframe.style.height = `${px}px`;
    };
    const onLoad = () => {
      detach();
      doc = iframe.contentDocument;
      if (!doc) return;
      const d = doc; // 窄化给闭包
      // srcDoc 构建到 load 之间 paintCss 可能已变（如加载途中切了主题），以最新值为准。
      applyPaintCss(d, paintCssRef.current ?? "");
      // 占位：就绪前先用估高，避免 iframe 默认高度造成的跳变。
      setHeight(cbRef.current.estimatedHeight ?? 0);

      let measuredHeight = 0;
      // 就绪后的重测（栏宽变化、图片晚到等）：高度确有变化才写回并回报，让测高缓存跟上真高——
      // 否则 section 重挂时先按旧缓存占位、再跳到真高。
      const measure = () => {
        const h = d.documentElement.scrollHeight;
        if (h === measuredHeight) return;
        measuredHeight = h;
        setHeight(h);
        cbRef.current.onMeasured?.(index, h);
      };
      let settled = false;
      const reportStable = () => {
        if (settled) return;
        settled = true;
        const h = d.documentElement.scrollHeight;
        measuredHeight = h;
        setHeight(h);
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
      doc.addEventListener("keydown", onDocKeyDown);
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

  useEffect(() => {
    if (docRef.current) applyPaintCss(docRef.current, paintCss ?? "");
  }, [paintCss]);

  // paintCss 有意不进依赖（经 ref 读取）：它变化时若重建 srcDoc，iframe 会整页重载、section 高度
  // 回落到估高，视口随之丢失阅读位置（#115）。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const srcDoc = useMemo(() => buildSrcDoc(html, styleCss, paintCssRef.current), [html, styleCss]);
  // 只取首次渲染的估高：之后高度一律经 setHeight（→ VirtualDocs.writeHeight）写入。若随 prop 变化，
  // 测得真高后的下一次重渲会由 React 直接写 DOM，绕过「视口上方暂缓写入」造成无补偿的位移。
  const initialHeight = useRef(estimatedHeight ?? 0).current;

  return (
    <iframe
      ref={iframeRef}
      srcDoc={srcDoc}
      sandbox="allow-same-origin"
      title={`section-${index}`}
      scrolling="no"
      // height 初值必须随首次渲染就位：iframe 从挂载到 load 事件之间若无 height，会以 Chromium
      // 默认 150px 参与布局——视口上方的 section 重挂时高度瞬时塌缩再恢复，virtuoso 的 scrollTop
      // 补偿与用户滚动竞争，正是「向上翻大跳」的主根因。load 后由 setHeight 手写真高接管。
      style={{ width: "100%", border: 0, display: "block", height: initialHeight }}
    />
  );
}
