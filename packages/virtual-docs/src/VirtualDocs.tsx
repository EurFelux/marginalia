import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { SectionFrame, type SectionSelectEvent } from "./SectionFrame";
import type { ViewportRect } from "./geometry";
import {
  estimateHeight,
  sectionScrollRatio,
  sectionsToUnload,
  topVisibleSection,
} from "./precision";

/** 未缓存 section 的默认占位高度（px）；缓存命中后用真实测高。 */
const DEFAULT_ESTIMATE = 600;
/** active range 两侧各保留的 section 数；超出即 unload。 */
const KEEP_DISTANCE = 5;

export interface VirtualDocsHandle {
  scrollToIndex: (index: number) => void;
  /** 滚到第 index 个 section 内 id===anchorId 的元素处（先滚 section，待 iframe 就绪后按其 offsetTop 精确定位）。 */
  scrollToAnchor: (index: number, anchorId: string) => void;
  /**
   * 滚到第 index 个 section 内由 resolveEl(doc) 定位的元素处（doc = 该 section 的 iframe 文档；返回 null=
   * 元素未就绪，继续重试）。收敛重试：virtuoso 须先测得 item 真高才认大 offset（冷启大 section 测量慢），
   * 故每轮按元素当前位置重发滚动直到它贴近 scroller 顶，或超时退化为 section 顶。供 CFI/锚点等元素定位。
   */
  scrollToSectionElement: (index: number, resolveEl: (doc: Document) => Element | null) => void;
  /** 对所有在挂 section 重跑 decorate（标注增删改后调用）。 */
  redecorate: () => void;
}

export interface VirtualDocsProps {
  count: number;
  /**
   * 按索引异步取该节的（资源已解析的）HTML。**必须引用稳定**（用 useCallback 记忆）：
   * 其身份变化会触发所有已挂载 section 重新加载。
   */
  loadSection: (index: number) => Promise<string>;
  styleCss?: string;
  initialIndex?: number;
  /**
   * 真实视口顶 section 索引变化时回调。优先用 IntersectionObserver 精确计算；
   * IntersectionObserver 不可用时 fallback 到 virtuoso rangeChanged.startIndex（近似，含 overscan）。
   */
  onTopSectionChange?: (index: number, meta: { scrollRatio: number }) => void;
  onSelect?: (e: SectionSelectEvent) => void;
  onSelectionCleared?: () => void;
  decorate?: (index: number, doc: Document) => void;
  onHighlightClick?: (annoId: string, rect: ViewportRect) => void;
  onHighlightHover?: (annoId: string, rect: ViewportRect) => void;
  onHighlightLeave?: () => void;
  onContentMouseDown?: () => void;
  /** 点 iframe 内站内 <a>（相对路径 / #fragment）时回调；消费方据此 resolve 到 section+anchor 跳转。 */
  onInternalLink?: (e: { index: number; href: string }) => void;
  /** 点 iframe 内外链（http/https/mailto）时回调；消费方开系统浏览器。 */
  onExternalLink?: (url: string) => void;
  /** 某 section 离开「active range ± KEEP_DISTANCE」时回调一次，供消费方释放其资源。 */
  onUnloadSection?: (index: number) => void;
  /** 透传给底层 Virtuoso 的 scroller 根元素的 className（如隐藏原生滚动条）。 */
  className?: string;
}

export const VirtualDocs = forwardRef<VirtualDocsHandle, VirtualDocsProps>(function VirtualDocs(
  {
    count,
    loadSection,
    styleCss,
    initialIndex,
    onTopSectionChange,
    onSelect,
    onSelectionCleared,
    decorate,
    onHighlightClick,
    onHighlightHover,
    onHighlightLeave,
    onContentMouseDown,
    onInternalLink,
    onExternalLink,
    onUnloadSection,
    className,
  },
  ref,
) {
  const vRef = useRef<VirtuosoHandle | null>(null);
  const [decorateNonce, setDecorateNonce] = useState(0);
  const [scrollerReady, setScrollerReady] = useState(0);
  useImperativeHandle(ref, () => {
    // 滚到第 index 个 section 内 resolveEl(doc) 定位的元素处。先用 virtuoso scrollToIndex 把该 section
    // 带进渲染窗口（其 iframe 才会加载），再**直接滚 DOM scroller**按真实渲染布局把元素移到 scroller 顶——
    // 不用 virtuoso 的 scrollToIndex({offset})，因为冷启大 section 未测全真高时大 offset 会溢出到下一 section。
    // delta = 元素在主窗口坐标的顶 − scroller 顶；元素主窗口顶 = iframe 在主窗口的顶 + 元素在 iframe 内的顶
    //（iframe scrolling=no、不内部滚动，故后者即元素 offsetTop）。连续两轮到位（<4px）才收尾，防 virtuoso 回弹。
    const scrollToSectionElement = (
      index: number,
      resolveEl: (doc: Document) => Element | null,
    ) => {
      vRef.current?.scrollToIndex({ index, align: "start" });
      let tries = 0;
      let settled = 0;
      const tick = () => {
        const scroller = scrollerEl.current;
        const frame = scroller?.querySelector<HTMLIFrameElement>(
          `[data-section-index="${index}"] iframe`,
        );
        const doc = frame?.contentDocument;
        const el = doc && doc.documentElement.scrollHeight > 0 ? resolveEl(doc) : null;
        if (el && scroller && frame) {
          const delta =
            frame.getBoundingClientRect().top +
            el.getBoundingClientRect().top -
            scroller.getBoundingClientRect().top;
          if (Math.abs(delta) < 4) {
            if (++settled >= 2) return; // 连续两轮稳定到位
          } else {
            settled = 0;
            scroller.scrollTop += delta; // 直接按真实布局定位，不溢出、不依赖 virtuoso 测高
          }
        }
        if (tries++ < 60) setTimeout(tick, 100);
        else console.warn("[virtual-docs] scrollToSectionElement: did not converge", index);
      };
      setTimeout(tick, 100);
    };
    return {
      scrollToIndex: (index: number) => vRef.current?.scrollToIndex({ index, align: "start" }),
      scrollToAnchor: (index: number, anchorId: string) =>
        scrollToSectionElement(index, (doc) => doc.getElementById(anchorId)),
      scrollToSectionElement,
      redecorate: () => setDecorateNonce((n) => n + 1),
    };
  }, []);

  const heightCache = useRef<Map<number, number>>(new Map());
  // 已 unload 的 section 集：避免重复 unload；section 重新进入保留区时移除（届时会 reload）。
  const unloaded = useRef<Set<number>>(new Set());
  const scrollerEl = useRef<HTMLElement | null>(null);
  const observedEls = useRef<Map<number, HTMLElement>>(new Map());
  const io = useRef<IntersectionObserver | null>(null);
  const lastTop = useRef<number | null>(null);

  // 对所有当前注册的 section 同步测 rect → 纯函数挑视口顶 → 上报。
  // force=true（滚动驱动）绕过 section index 去重：同一 section 内跨锚点滚动也上报最新 scrollRatio，
  // 驱动消费方的锚点级当前章/进度跟随（IO 仅在 section 边界触发，section 内不重触发）。
  const recomputeTop = (force = false) => {
    const scroller = scrollerEl.current;
    if (!scroller) return;
    const vt = scroller.getBoundingClientRect().top;
    const secs = [...observedEls.current.entries()].map(([index, el]) => {
      const r = el.getBoundingClientRect();
      return { index, top: r.top, bottom: r.bottom };
    });
    const section = topVisibleSection(secs, vt);
    if (section && (section.index !== lastTop.current || force)) {
      lastTop.current = section.index;
      onTopSectionChange?.(section.index, { scrollRatio: sectionScrollRatio(section, vt) });
    }
  };
  // IO 回调捕获 build 时的 recomputeTop；用 ref 持最新值，使 onTopSectionChange 身份变化后
  // 回调仍调最新闭包（镜像 SectionFrame 的 cbRef 模式），避免 stale。
  const recomputeRef = useRef(recomputeTop);
  recomputeRef.current = recomputeTop;

  const ioSupported = typeof IntersectionObserver !== "undefined";

  // virtual-docs 不过 React Compiler（renderer 才过；本包经 node_modules 软链被 babel 的
  // /node_modules/ 默认 exclude 排除）→ 传给 virtuoso/子组件的回调必须手动 useCallback 稳定身份。
  // 注册/注销由 LazySection 在挂载/卸载时调用；不稳定会让其注册 effect 每渲染重跑。
  const registerSection = useCallback((index: number, el: HTMLElement) => {
    observedEls.current.set(index, el);
    io.current?.observe(el);
  }, []);
  const unregisterSection = useCallback((index: number, el: HTMLElement) => {
    observedEls.current.delete(index);
    io.current?.unobserve(el);
  }, []);
  // scrollerRef 必须稳定身份：virtuoso 把它当 callback ref，内联身份每渲染变会触发
  // detach/attach → setScrollerReady → 重渲 → … 无限循环（Maximum update depth）。
  const handleScrollerRef = useCallback((el: HTMLElement | null | Window) => {
    scrollerEl.current = el instanceof HTMLElement ? el : null;
    setScrollerReady((n) => n + 1);
  }, []);

  // scroller 就绪后建 IO，observe 已注册的元素 + throttle 滚动监听。
  useEffect(() => {
    if (!ioSupported) return;
    const scroller = scrollerEl.current;
    if (!scroller) return;
    const obs = new IntersectionObserver(() => recomputeRef.current(), { root: scroller });
    io.current = obs;
    for (const el of observedEls.current.values()) obs.observe(el);
    // IO 仅在 section 边界触发；一个 section 含多锚点章时（锚点级切章的书），section 内滚动须靠
    // 滚动事件以当前 scrollRatio 重算顶部（force 绕过 index 去重）。throttle（leading+trailing）抑制每帧风暴。
    const THROTTLE_MS = 120;
    let lastRun = 0;
    let trailing: ReturnType<typeof setTimeout> | undefined;
    const onScroll = () => {
      const elapsed = performance.now() - lastRun;
      if (elapsed >= THROTTLE_MS) {
        lastRun = performance.now();
        recomputeRef.current(true);
      } else if (!trailing) {
        // 尾随一次：滚动停在节流窗口内时，确保最终位置也重算。
        trailing = setTimeout(() => {
          trailing = undefined;
          lastRun = performance.now();
          recomputeRef.current(true);
        }, THROTTLE_MS - elapsed);
      }
    };
    scroller.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      obs.disconnect();
      io.current = null;
      scroller.removeEventListener("scroll", onScroll);
      if (trailing) clearTimeout(trailing);
    };
    // scrollerReady nonce 触发重建（见 Step 5 的 scrollerRef）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [scrollerReady, ioSupported]);

  // styleCss（排版偏好/主题）变更会改变所有 section 高度 → 整体失效缓存。
  useEffect(() => {
    heightCache.current.clear();
  }, [styleCss]);

  // itemContent 身份每渲染变会让 virtuoso 重渲全部在挂行 → 手动 useCallback 稳定（见上）。
  const onMeasured = useCallback((i: number, h: number) => {
    heightCache.current.set(i, h);
  }, []);
  const itemContent = useCallback(
    (index: number) => (
      <LazySection
        index={index}
        loadSection={loadSection}
        styleCss={styleCss}
        onSelect={onSelect}
        onSelectionCleared={onSelectionCleared}
        decorate={decorate}
        onHighlightClick={onHighlightClick}
        onHighlightHover={onHighlightHover}
        onHighlightLeave={onHighlightLeave}
        decorateNonce={decorateNonce}
        onContentMouseDown={onContentMouseDown}
        onInternalLink={onInternalLink}
        onExternalLink={onExternalLink}
        estimatedHeight={estimateHeight(heightCache.current, index, DEFAULT_ESTIMATE)}
        onMeasured={onMeasured}
        registerSection={registerSection}
        unregisterSection={unregisterSection}
      />
    ),
    [
      loadSection,
      styleCss,
      onSelect,
      onSelectionCleared,
      decorate,
      onHighlightClick,
      onHighlightHover,
      onHighlightLeave,
      decorateNonce,
      onContentMouseDown,
      onInternalLink,
      onExternalLink,
      onMeasured,
      registerSection,
      unregisterSection,
    ],
  );

  return (
    <Virtuoso
      ref={vRef}
      className={className}
      style={{ height: "100%" }}
      totalCount={count}
      initialTopMostItemIndex={initialIndex ?? 0}
      itemContent={itemContent}
      scrollerRef={handleScrollerRef}
      rangeChanged={(range) => {
        if (!ioSupported) onTopSectionChange?.(range.startIndex, { scrollRatio: 0 }); // fallback：近似
        const lo = Math.max(0, range.startIndex - KEEP_DISTANCE);
        const hi = Math.min(count - 1, range.endIndex + KEEP_DISTANCE);
        for (let i = lo; i <= hi; i++) unloaded.current.delete(i);
        for (const i of sectionsToUnload(range, count, KEEP_DISTANCE)) {
          if (!unloaded.current.has(i)) {
            unloaded.current.add(i);
            onUnloadSection?.(i);
          }
        }
      }}
    />
  );
});

function LazySection({
  index,
  loadSection,
  styleCss,
  onSelect,
  onSelectionCleared,
  decorate,
  onHighlightClick,
  onHighlightHover,
  onHighlightLeave,
  decorateNonce,
  onContentMouseDown,
  onInternalLink,
  onExternalLink,
  estimatedHeight,
  onMeasured,
  registerSection,
  unregisterSection,
}: {
  index: number;
  loadSection: (index: number) => Promise<string>;
  styleCss?: string;
  onSelect?: (e: SectionSelectEvent) => void;
  onSelectionCleared?: () => void;
  decorate?: (index: number, doc: Document) => void;
  onHighlightClick?: (annoId: string, rect: ViewportRect) => void;
  onHighlightHover?: (annoId: string, rect: ViewportRect) => void;
  onHighlightLeave?: () => void;
  decorateNonce?: number;
  onContentMouseDown?: () => void;
  onInternalLink?: (e: { index: number; href: string }) => void;
  onExternalLink?: (url: string) => void;
  estimatedHeight?: number;
  onMeasured?: (index: number, height: number) => void;
  registerSection: (index: number, el: HTMLElement) => void;
  unregisterSection: (index: number, el: HTMLElement) => void;
}) {
  const [html, setHtml] = useState<string | null>(null);
  const outerRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    let alive = true;
    loadSection(index)
      .then((h) => alive && setHtml(h))
      .catch((err) => {
        console.error("[virtual-docs] section load failed", index, err);
        if (alive) setHtml("<p>（本节加载失败）</p>");
      });
    return () => {
      alive = false;
    };
  }, [index, loadSection]);

  useEffect(() => {
    const el = outerRef.current;
    if (!el) return;
    registerSection(index, el);
    return () => unregisterSection(index, el);
  }, [index, registerSection, unregisterSection]);

  return (
    <div ref={outerRef} data-section-index={index}>
      {html == null ? (
        <div style={{ height: estimatedHeight ?? 200 }} />
      ) : (
        <SectionFrame
          index={index}
          html={html}
          styleCss={styleCss}
          onSelect={onSelect}
          onSelectionCleared={onSelectionCleared}
          decorate={decorate}
          onHighlightClick={onHighlightClick}
          onHighlightHover={onHighlightHover}
          onHighlightLeave={onHighlightLeave}
          decorateNonce={decorateNonce}
          onContentMouseDown={onContentMouseDown}
          onInternalLink={onInternalLink}
          onExternalLink={onExternalLink}
          estimatedHeight={estimatedHeight}
          onMeasured={onMeasured}
        />
      )}
    </div>
  );
}
