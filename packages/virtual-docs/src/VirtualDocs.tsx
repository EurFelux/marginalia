import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { SectionFrame, type SectionSelectEvent } from "./SectionFrame";
import type { ViewportRect } from "./geometry";
import {
  calibratedEstimate,
  deferBeforeLoadedIndex,
  loadedFromIndexAfterNavigation,
  loadedFromIndexAfterVisibleTop,
  sectionScrollRatio,
  sectionsToUnload,
  topVisibleSection,
} from "./precision";
import { startScrollConvergence } from "./scroll-convergence";

/** 未缓存 section 的默认占位高度（px）；缓存命中后用真实测高。 */
const DEFAULT_ESTIMATE = 600;
/** active range 两侧各保留的 section 数；超出即 unload。 */
const KEEP_DISTANCE = 5;
/**
 * 视口外预挂载缓冲（px），两侧对称给足。作用有二：① 向上滚动时上方 section 在进入视口前完成
 * 挂载与测量，高度修正发生在可视区外、无需大幅 scrollTop 补偿；② 快速滚动时进入方向的 section
 * 提前挂载、加载（loadSection 异步解析 ePub HTML 有延迟），抵达视口时内容已就绪——消除「内容
 * 未就绪」的空白占位帧。给到 2400 是实测停手就绪（settling）中位 ~8ms 的拐点；过大徒增同挂 iframe 数。
 */
const OVERSCAN_PX = { top: 2400, bottom: 2400 };

export interface VirtualDocsHandle {
  scrollToIndex: (index: number) => void;
  /** 滚到第 index 个 section 内 id===anchorId 的元素处（先滚 section，待 iframe 就绪后按其 offsetTop 精确定位）。 */
  scrollToAnchor: (index: number, anchorId: string) => void;
  /**
   * 滚到第 index 个 section 内由 resolveEl(doc) 定位的元素处（doc = 该 section 的 iframe 文档；返回 null=
   * 元素未就绪，继续重试）。收敛重试：virtuoso 须先测得 item 真高才认大 offset（冷启大 section 测量慢），
   * 故每轮按元素当前位置重发滚动直到它贴近 scroller 顶，或超时退化为 section 顶。供 CFI/锚点等元素定位。
   */
  scrollToSectionElement: (
    index: number,
    resolveEl: (doc: Document) => Element | null,
    onSettled?: () => void,
  ) => void;
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
   * section 的相对体量（如字符数），供未测量 section 按「已测 px/权重比」外推估高。
   * 不传则未测量 section 一律用固定默认估高（600px）——与真实高度差距大时，
   * 向上滚动的首次测量修正会引发可感知跳变。**须引用稳定**（同 loadSection）。
   */
  sectionWeight?: (index: number) => number;
  /**
   * 尚无实测 section 时的最低 px/权重估算；适合字符数等有稳定量纲的权重。
   * 仅作冷启动保护，首个有效实测样本出现后由动态校准取代。
   */
  initialPxPerWeight?: number;
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
  /** 用户直接操作滚动区时触发；消费方可据此放弃尚未完成的位置恢复。 */
  onUserNavigation?: () => void;
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
    sectionWeight,
    initialPxPerWeight,
    onTopSectionChange,
    onSelect,
    onSelectionCleared,
    decorate,
    onHighlightClick,
    onHighlightHover,
    onHighlightLeave,
    onContentMouseDown,
    onUserNavigation,
    onInternalLink,
    onExternalLink,
    onUnloadSection,
    className,
  },
  ref,
) {
  const vRef = useRef<VirtuosoHandle | null>(null);
  const scrollerEl = useRef<HTMLElement | null>(null);
  const cancelScrollRef = useRef<(() => void) | null>(null);
  const onUserNavigationRef = useRef(onUserNavigation);
  onUserNavigationRef.current = onUserNavigation;
  const [decorateNonce, setDecorateNonce] = useState(0);
  const [scrollerReady, setScrollerReady] = useState(0);
  const [userNavigationStarted, setUserNavigationStarted] = useState(false);
  const [loadedFromIndex, setLoadedFromIndex] = useState(initialIndex ?? 0);
  const rangeLoadingEnabledRef = useRef(false);
  const cancelPendingScroll = useCallback(() => {
    cancelScrollRef.current?.();
    cancelScrollRef.current = null;
  }, []);
  useImperativeHandle(ref, () => {
    // 滚到第 index 个 section 内 resolveEl(doc) 定位的元素处。先用 scrollToIndex 把 section 带进渲染
    // 窗口（其 iframe 才加载），再按元素与 scroller 顶的实际偏差重复定位，直到误差收敛。不能只用
    // scrollHeight ≥ section 高判断「已测量」：目标前方的超长 section 仍可能继续修正高度，使一次定位随后
    // 漂走。超时（≤300×100ms=30s，覆盖冷启超长 section 的迟到测量）退化为最后一次位置（不卡死、不白屏）。
    const scrollToSectionElement = (
      index: number,
      resolveEl: (doc: Document) => Element | null,
      onSettled?: () => void,
    ) => {
      rangeLoadingEnabledRef.current = false;
      if (!onSettled) {
        setUserNavigationStarted(true);
        setLoadedFromIndex((current) => loadedFromIndexAfterNavigation(current, index));
      }
      cancelPendingScroll();
      vRef.current?.scrollToIndex({ index, align: "start" });
      const attempt = () => {
        const scroller = scrollerEl.current;
        const frame = scroller?.querySelector<HTMLIFrameElement>(
          `[data-section-index="${index}"] iframe`,
        );
        const doc = frame?.contentDocument;
        const docRoot = doc?.documentElement;
        const el = doc && docRoot && docRoot.scrollHeight > 0 ? resolveEl(doc) : null;
        if (el && scroller && docRoot) {
          const offset = el.getBoundingClientRect().top - docRoot.getBoundingClientRect().top;
          const delta =
            frame!.getBoundingClientRect().top + offset - scroller.getBoundingClientRect().top;
          if (Math.abs(delta) <= 4) return true;
          vRef.current?.scrollToIndex({ index, align: "start", offset });
        } else {
          // 前方超长 section 的实测高度刚修正时，首次跳转可能只落到目标附近，目标 iframe 尚未挂载。
          // 用最新高度表重发 section 级定位，把目标重新带入渲染窗口后再解析元素。
          vRef.current?.scrollToIndex({ index, align: "start" });
        }
        return false;
      };
      cancelScrollRef.current = startScrollConvergence(
        attempt,
        () => {
          cancelScrollRef.current = null;
          console.warn("[virtual-docs] scrollToSectionElement: position did not converge", index);
        },
        {
          // 超长 section 的初次对齐可能是假象：前方 iframe 的迟到测高会在数秒后再次推开目标。
          // 至少观察 6 秒，并要求连续 5 次对齐；用户输入或新导航仍会立即取消这段观察。
          minimumAttempts: 60,
          successesRequired: 5,
          maxAttempts: 300,
          onSuccess: () => {
            cancelScrollRef.current = null;
            onSettled?.();
            recomputeRef.current(true);
          },
        },
      );
    };
    return {
      scrollToIndex: (index: number) => {
        setUserNavigationStarted(true);
        rangeLoadingEnabledRef.current = false;
        setLoadedFromIndex((current) => loadedFromIndexAfterNavigation(current, index));
        cancelPendingScroll();
        vRef.current?.scrollToIndex({ index, align: "start" });
      },
      scrollToAnchor: (index: number, anchorId: string) =>
        scrollToSectionElement(index, (doc) => doc.getElementById(anchorId)),
      scrollToSectionElement,
      redecorate: () => setDecorateNonce((n) => n + 1),
    };
  }, [cancelPendingScroll]);

  const heightCache = useRef<Map<number, number>>(new Map());
  // 已 unload 的 section 集：避免重复 unload；section 重新进入保留区时移除（届时会 reload）。
  const unloaded = useRef<Set<number>>(new Set());
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
    if (section) {
      setLoadedFromIndex((current) =>
        loadedFromIndexAfterVisibleTop(current, section.index, rangeLoadingEnabledRef.current),
      );
    }
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
  const handleUserNavigation = useCallback(() => {
    cancelPendingScroll();
    onUserNavigationRef.current?.();
  }, [cancelPendingScroll]);
  const handleUserScrollNavigation = useCallback(() => {
    setUserNavigationStarted(true);
    rangeLoadingEnabledRef.current = true;
    handleUserNavigation();
  }, [handleUserNavigation]);

  // A new imperative command cancels the previous one above; genuine user input also owns the
  // viewport from that point onward, so stale restoration retries must not pull it back.
  useEffect(() => {
    const scroller = scrollerEl.current;
    if (!scroller) return;
    const scrollEvents = ["wheel", "touchstart", "keydown"] as const;
    for (const event of scrollEvents) scroller.addEventListener(event, handleUserScrollNavigation);
    scroller.addEventListener("pointerdown", handleUserNavigation);
    return () => {
      for (const event of scrollEvents)
        scroller.removeEventListener(event, handleUserScrollNavigation);
      scroller.removeEventListener("pointerdown", handleUserNavigation);
    };
  }, [scrollerReady, handleUserNavigation, handleUserScrollNavigation]);

  useEffect(() => cancelPendingScroll, [cancelPendingScroll]);

  // scroller 就绪后建 IO，observe 已注册的元素 + throttle 滚动监听。
  useEffect(() => {
    const scroller = scrollerEl.current;
    if (!scroller) return;
    const obs = ioSupported
      ? new IntersectionObserver(() => recomputeRef.current(), { root: scroller })
      : null;
    io.current = obs;
    if (obs) {
      for (const el of observedEls.current.values()) obs.observe(el);
    }
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
      obs?.disconnect();
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
        deferLoad={deferBeforeLoadedIndex(loadedFromIndex, index)}
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
        onUserNavigation={handleUserNavigation}
        onUserScrollNavigation={handleUserScrollNavigation}
        onInternalLink={onInternalLink}
        onExternalLink={onExternalLink}
        estimatedHeight={calibratedEstimate(
          heightCache.current,
          sectionWeight,
          index,
          DEFAULT_ESTIMATE,
          initialPxPerWeight,
        )}
        onMeasured={onMeasured}
        registerSection={registerSection}
        unregisterSection={unregisterSection}
      />
    ),
    [
      loadSection,
      initialIndex,
      userNavigationStarted,
      loadedFromIndex,
      styleCss,
      sectionWeight,
      initialPxPerWeight,
      onSelect,
      onSelectionCleared,
      decorate,
      onHighlightClick,
      onHighlightHover,
      onHighlightLeave,
      decorateNonce,
      onContentMouseDown,
      handleUserNavigation,
      handleUserScrollNavigation,
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
      increaseViewportBy={
        (initialIndex ?? 0) > 0 && !userNavigationStarted
          ? { top: 0, bottom: OVERSCAN_PX.bottom }
          : OVERSCAN_PX
      }
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
  deferLoad,
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
  onUserNavigation,
  onUserScrollNavigation,
  onInternalLink,
  onExternalLink,
  estimatedHeight,
  onMeasured,
  registerSection,
  unregisterSection,
}: {
  index: number;
  deferLoad: boolean;
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
  onUserNavigation?: () => void;
  onUserScrollNavigation?: () => void;
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
    if (deferLoad) {
      setHtml(null);
      return;
    }
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
  }, [index, loadSection, deferLoad]);

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
          onUserNavigation={onUserNavigation}
          onUserScrollNavigation={onUserScrollNavigation}
          onInternalLink={onInternalLink}
          onExternalLink={onExternalLink}
          estimatedHeight={estimatedHeight}
          onMeasured={onMeasured}
        />
      )}
    </div>
  );
}
