import { forwardRef, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { SectionFrame, type SectionSelectEvent } from "./SectionFrame";
import type { ViewportRect } from "./geometry";
import { estimateHeight, sectionsToUnload } from "./precision";

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
   * 顶部可见 section 索引变化时回调。注意这是 virtuoso 渲染区的起始索引（含 overscan），
   * **近似**而非像素级视口顶——滚动中可能比真正视口顶部的 section 略小一两个。用于当前章/进度足够。
   */
  onTopIndexChange?: (index: number) => void;
  onSelect?: (e: SectionSelectEvent) => void;
  onSelectionCleared?: () => void;
  decorate?: (index: number, doc: Document) => void;
  onHighlightClick?: (annoId: string, rect: ViewportRect) => void;
  onContentMouseDown?: () => void;
  /** 某 section 离开「active range ± KEEP_DISTANCE」时回调一次，供消费方释放其资源。 */
  onUnloadSection?: (index: number) => void;
}

export const VirtualDocs = forwardRef<VirtualDocsHandle, VirtualDocsProps>(function VirtualDocs(
  {
    count,
    loadSection,
    styleCss,
    initialIndex,
    onTopIndexChange,
    onSelect,
    onSelectionCleared,
    decorate,
    onHighlightClick,
    onContentMouseDown,
    onUnloadSection,
  },
  ref,
) {
  const vRef = useRef<VirtuosoHandle | null>(null);
  const [decorateNonce, setDecorateNonce] = useState(0);
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
  // styleCss（排版偏好/主题）变更会改变所有 section 高度 → 整体失效缓存。
  useEffect(() => {
    heightCache.current.clear();
  }, [styleCss]);

  // onMeasured / itemContent 故意不手写 useCallback——virtual-docs 经 React Compiler 编译
  //（renderer 的 vite babel 覆盖工作区源码包：symlink 解析为 packages/ 真实路径、不含 node_modules，
  // 故被 RC 处理），由其自动记忆保持身份稳定。否则身份每次渲染变化会让 Virtuoso 重渲全部在挂行。
  const onMeasured = (i: number, h: number) => {
    heightCache.current.set(i, h);
  };
  const itemContent = (index: number) => (
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
    />
  );

  return (
    <Virtuoso
      ref={vRef}
      style={{ height: "100%" }}
      totalCount={count}
      initialTopMostItemIndex={initialIndex ?? 0}
      itemContent={itemContent}
      rangeChanged={(range) => {
        onTopIndexChange?.(range.startIndex);
        // 保留区内的从 unloaded 移除（将/已 reload）
        const lo = Math.max(0, range.startIndex - KEEP_DISTANCE);
        const hi = Math.min(count - 1, range.endIndex + KEEP_DISTANCE);
        for (let i = lo; i <= hi; i++) unloaded.current.delete(i);
        // 保留区外、尚未 unload 的 → unload 一次
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
}) {
  const [html, setHtml] = useState<string | null>(null);
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

  if (html == null) return <div style={{ height: estimatedHeight ?? 200 }} />;
  return (
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
  );
}
