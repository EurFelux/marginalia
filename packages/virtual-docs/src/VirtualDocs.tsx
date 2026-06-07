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
  onContentMouseDown?: () => void;
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
    onContentMouseDown,
    onUnloadSection,
    className,
  },
  ref,
) {
  const vRef = useRef<VirtuosoHandle | null>(null);
  const [decorateNonce, setDecorateNonce] = useState(0);
  const [scrollerReady, setScrollerReady] = useState(0);
  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (index: number) => vRef.current?.scrollToIndex({ index, align: "start" }),
      redecorate: () => setDecorateNonce((n) => n + 1),
    }),
    [],
  );

  const heightCache = useRef<Map<number, number>>(new Map());
  // 已 unload 的 section 集：避免重复 unload；section 重新进入保留区时移除（届时会 reload）。
  const unloaded = useRef<Set<number>>(new Set());
  const scrollerEl = useRef<HTMLElement | null>(null);
  const observedEls = useRef<Map<number, HTMLElement>>(new Map());
  const io = useRef<IntersectionObserver | null>(null);
  const lastTop = useRef<number | null>(null);

  // 对所有当前注册的 section 同步测 rect → 纯函数挑视口顶 → 去重上报。
  const recomputeTop = () => {
    const scroller = scrollerEl.current;
    if (!scroller) return;
    const vt = scroller.getBoundingClientRect().top;
    const secs = [...observedEls.current.entries()].map(([index, el]) => {
      const r = el.getBoundingClientRect();
      return { index, top: r.top, bottom: r.bottom };
    });
    const section = topVisibleSection(secs, vt);
    if (section && section.index !== lastTop.current) {
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

  // scroller 就绪后建 IO，observe 已注册的元素。
  useEffect(() => {
    if (!ioSupported) return;
    const scroller = scrollerEl.current;
    if (!scroller) return;
    const obs = new IntersectionObserver(() => recomputeRef.current(), { root: scroller });
    io.current = obs;
    for (const el of observedEls.current.values()) obs.observe(el);
    return () => {
      obs.disconnect();
      io.current = null;
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
        decorateNonce={decorateNonce}
        onContentMouseDown={onContentMouseDown}
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
      decorateNonce,
      onContentMouseDown,
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
  decorateNonce,
  onContentMouseDown,
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
  decorateNonce?: number;
  onContentMouseDown?: () => void;
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
          decorateNonce={decorateNonce}
          onContentMouseDown={onContentMouseDown}
          estimatedHeight={estimatedHeight}
          onMeasured={onMeasured}
        />
      )}
    </div>
  );
}
