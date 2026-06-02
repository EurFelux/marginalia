import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { SectionFrame, type SectionSelectEvent } from "./SectionFrame";
import type { ViewportRect } from "./geometry";

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
    ],
  );

  return (
    <Virtuoso
      ref={vRef}
      style={{ height: "100%" }}
      totalCount={count}
      initialTopMostItemIndex={initialIndex ?? 0}
      itemContent={itemContent}
      rangeChanged={({ startIndex }) => onTopIndexChange?.(startIndex)}
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

  if (html == null) return <div style={{ minHeight: 200 }} />;
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
    />
  );
}
