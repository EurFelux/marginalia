import { useEffect, useRef, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import type { HighlightColor } from "#/mock/types";
import { HIGHLIGHT } from "#/highlight";
import { useReaderAI } from "#/reader-ai-context";
import { useSelection } from "#/components/reader/useSelection";
import { SelectionToolbar } from "#/components/reader/SelectionToolbar";
import { HighlightPopover } from "#/components/reader/HighlightPopover";
import { cn } from "#/lib/utils";

export function ReaderPane() {
  const { t } = useTranslation();
  const { book, prefs, setSelection, setCurrentChapterId } = useReaderAI();
  const containerRef = useRef<HTMLDivElement | null>(null);
  useSelection(containerRef, setSelection);

  // 滚动监听：把视口顶部附近的章节标记为“当前章”（驱动摘要 pill / 会话路由感）
  useEffect(() => {
    const root = containerRef.current;
    if (!root) return;
    const obs = new IntersectionObserver(
      (entries) => {
        const top = entries
          .filter((e) => e.isIntersecting)
          .sort((a, b) => b.intersectionRatio - a.intersectionRatio)[0];
        const id = top && (top.target as HTMLElement).dataset.chapter;
        if (id) setCurrentChapterId(id);
      },
      { root, threshold: [0.2, 0.5], rootMargin: "-15% 0px -65% 0px" },
    );
    for (const el of root.querySelectorAll("[data-chapter]")) obs.observe(el);
    return () => obs.disconnect();
  }, [setCurrentChapterId]);

  return (
    <div ref={containerRef} className="no-scrollbar relative h-full overflow-y-auto bg-background">
      <div
        className="mx-auto px-10 py-14 font-serif"
        style={{
          maxWidth: prefs.maxWidth,
          fontSize: `${1.125 * prefs.fontScale}rem`,
          lineHeight: prefs.lineHeight,
        }}
      >
        {book.chapters.map((ch) => (
          <article key={ch.id} data-chapter={ch.id} id={`chapter-${ch.id}`} className="mb-20">
            <h2 className="mb-8 text-center font-sans text-xs font-semibold uppercase tracking-[0.24em] text-muted-foreground">
              {ch.title}
            </h2>
            {ch.paragraphs.map((p, i) => (
              <HighlightedParagraph key={i} chapterId={ch.id} index={i} text={p} />
            ))}
          </article>
        ))}
        <div className="pb-8 text-center font-sans text-xs text-muted-foreground">
          {t("reader.end")}
        </div>
      </div>
      <SelectionToolbar />
      <HighlightPopover />
    </div>
  );
}

interface ParaHit {
  annId: string;
  color: HighlightColor;
  start: number;
  end: number;
  hasNote: boolean;
}

function HighlightedParagraph({
  chapterId,
  index,
  text,
}: {
  chapterId: string;
  index: number;
  text: string;
}) {
  const { annotationsForParagraph, openHighlightPopover } = useReaderAI();
  const hits = annotationsForParagraph(chapterId, index);

  return (
    <p
      data-paragraph
      data-pidx={index}
      id={`p-${chapterId}-${index}`}
      className="mb-6 text-justify text-foreground/90 selection:bg-primary/25"
    >
      {hits.length === 0 ? text : renderSegments(text, hits, openHighlightPopover)}
    </p>
  );
}

function renderSegments(
  text: string,
  hits: ParaHit[],
  open: (id: string, x: number, y: number) => void,
): ReactNode[] {
  const sorted = [...hits].sort((a, b) => a.start - b.start);
  const nodes: ReactNode[] = [];
  let cursor = 0;
  sorted.forEach((h, k) => {
    const s = Math.max(cursor, h.start);
    const e = Math.max(s, Math.min(h.end, text.length));
    if (s > cursor) nodes.push(text.slice(cursor, s));
    if (e > s) {
      nodes.push(
        <mark
          key={`${h.annId}-${k}`}
          data-annotation={h.annId}
          onClick={(ev) => {
            ev.stopPropagation();
            open(h.annId, ev.clientX, ev.clientY);
          }}
          className={cn(
            "cursor-pointer rounded-[3px] text-inherit transition-colors",
            HIGHLIGHT[h.color].mark,
            h.hasNote && "underline decoration-foreground/40 decoration-dotted underline-offset-4",
          )}
        >
          {text.slice(s, e)}
          {h.hasNote && <sup className="ml-0.5 text-[0.6em] text-foreground/55">✎</sup>}
        </mark>,
      );
    }
    cursor = e;
  });
  if (cursor < text.length) nodes.push(text.slice(cursor));
  return nodes;
}
