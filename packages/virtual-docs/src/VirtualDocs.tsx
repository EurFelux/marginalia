import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { SectionFrame, type SectionSelectEvent } from "./SectionFrame";

export interface VirtualDocsHandle {
  scrollToIndex: (index: number) => void;
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
}

export const VirtualDocs = forwardRef<VirtualDocsHandle, VirtualDocsProps>(function VirtualDocs(
  { count, loadSection, styleCss, initialIndex, onTopIndexChange, onSelect, onSelectionCleared },
  ref,
) {
  const vRef = useRef<VirtuosoHandle | null>(null);
  useImperativeHandle(
    ref,
    () => ({
      scrollToIndex: (index: number) => vRef.current?.scrollToIndex({ index, align: "start" }),
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
      />
    ),
    [loadSection, styleCss, onSelect, onSelectionCleared],
  );

  return (
    <Virtuoso
      ref={vRef}
      style={{ height: "100%" }}
      totalCount={count}
      initialTopMostItemIndex={initialIndex}
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
}: {
  index: number;
  loadSection: (index: number) => Promise<string>;
  styleCss?: string;
  onSelect?: (e: SectionSelectEvent) => void;
  onSelectionCleared?: () => void;
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
    />
  );
}
