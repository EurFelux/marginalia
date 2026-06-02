import { useEffect, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { VirtualDocs, type VirtualDocsHandle } from "@marginalia/virtual-docs";
import type { ChapterRefDto } from "@shared/library";
import { useReaderStore } from "../store/reader-store";
import { qk } from "../query/keys";
import { chapterIdByHref } from "./chapter-id-by-href";
import { createEpubBook, type EpubBook } from "./epub-book";

interface Props {
  bookId: string;
  chapters: ChapterRefDto[];
}

const SAVE_DEBOUNCE_MS = 1000;

export function EpubReader({ bookId, chapters }: Props) {
  const vRef = useRef<VirtualDocsHandle | null>(null);
  const [book, setBook] = useState<EpubBook | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const currentChapterId = useReaderStore((s) => s.currentChapterId);
  const setCurrentChapter = useReaderStore((s) => s.setCurrentChapter);

  // 防循环：记录最近一次「由滚动得出的顶部章 id」；跳章 effect 只在目标≠它时滚动。
  const topChapterIdRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bytes = useQuery({
    queryKey: qk.epubBytes(bookId),
    queryFn: () => window.api.library.readEpubBytes({ bookId }),
    staleTime: Infinity,
  });

  // 恢复位置：进度 CFI → spine index（开书时取一次）。
  const progress = useQuery({
    queryKey: qk.progress(bookId),
    queryFn: () => window.api.progress.get({ bookId }),
    staleTime: Infinity,
  });

  useEffect(() => {
    if (!bytes.data) return;
    let alive = true;
    let created: EpubBook | null = null;
    setParseError(null);
    createEpubBook(bytes.data)
      .then((b) => {
        if (!alive) {
          b.destroy();
          return;
        }
        created = b;
        setBook(b);
      })
      .catch((err: unknown) => {
        if (alive) setParseError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
      created?.destroy();
      setBook(null);
      // 换书/重解析时丢弃挂起的进度保存与滚动章快照，避免把上一本的状态带到下一本。
      if (saveTimer.current) clearTimeout(saveTimer.current);
      topChapterIdRef.current = null;
    };
  }, [bytes.data]);

  // 跳章：currentChapterId 变化（ChapterList 点击）→ 滚到对应 spine index。
  useEffect(() => {
    if (!book || currentChapterId == null) return;
    if (currentChapterId === topChapterIdRef.current) return; // 由滚动引起的同步，不回滚
    const ch = chapters.find((c) => c.id === currentChapterId);
    if (!ch) return;
    const idx = book.indexOfHref(ch.href);
    if (idx >= 0) vRef.current?.scrollToIndex(idx);
  }, [book, currentChapterId, chapters]);

  // 恢复初始位置：进度 CFI → index（仅在 book+progress 就绪时算一次初值）。
  const initialIndex =
    book && progress.data?.cfi != null
      ? (() => {
          const i = book.indexOfCfi(progress.data.cfi);
          return i >= 0 ? i : 0;
        })()
      : 0;

  const onTopIndexChange = (index: number) => {
    if (!book) return;
    // 当前章高亮
    const href = book.hrefAtIndex(index);
    const chId = href ? chapterIdByHref(chapters, href) : null;
    if (chId) {
      topChapterIdRef.current = chId;
      if (chId !== currentChapterId) setCurrentChapter(chId);
    }
    // 防抖存进度（section 级 CFI）
    const cfi = book.cfiAtIndex(index);
    if (cfi) {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void window.api.progress.save({ bookId, cfi });
      }, SAVE_DEBOUNCE_MS);
    }
  };

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  if (bytes.isError) return <ReaderError message="无法读取此书的文件。" />;
  if (parseError) return <ReaderError message={`无法渲染此书：${parseError}`} />;
  // 等字节+进度都就绪再挂 VirtualDocs，使 initialIndex 一次到位（避免先 0 再跳）。
  if (!book || progress.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">载入中…</div>
    );
  }

  return (
    <div className="h-full">
      <VirtualDocs
        ref={vRef}
        count={book.count}
        loadSection={book.loadSection}
        initialIndex={initialIndex}
        onTopIndexChange={onTopIndexChange}
      />
    </div>
  );
}

function ReaderError({ message }: { message: string }) {
  return (
    <div className="flex h-full flex-col items-center justify-center gap-2 text-muted-foreground">
      <p>{message}</p>
    </div>
  );
}
