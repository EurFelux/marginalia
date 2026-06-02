import { forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState } from "react";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { SectionFrame, type SectionSelectEvent } from "./SectionFrame";

export interface VirtualDocsHandle {
  scrollToIndex: (index: number) => void;
}

export interface VirtualDocsProps {
  count: number;
  loadSection: (index: number) => Promise<string>;
  styleCss?: string;
  initialIndex?: number;
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
      .catch(() => alive && setHtml("<p>（本节加载失败）</p>"));
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
