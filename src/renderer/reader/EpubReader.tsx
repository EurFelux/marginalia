import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { createLogger } from "@renderer/logger";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  VirtualDocs,
  type VirtualDocsHandle,
  type SectionSelectEvent,
} from "@marginalia/virtual-docs";
import type { ChapterRefDto } from "@shared/library";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { useAnnotationStore } from "@renderer/store/annotation-store";
import { useNoteHoverStore } from "@renderer/store/note-hover-store";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { qk } from "../query/keys";
import { chapterIdByHref } from "./chapter-id-by-href";
import { createEpubBook, type EpubBook } from "./epub-book";
import { epubPercent } from "./percent";
import { prefsToCss } from "./prefs-to-css";
import { readerThemeCss } from "./reader-theme-css";
import { sectionSelectToSelectionInfo } from "./epub-selection";
import { applyAnnotations } from "./apply-annotations";
import { ANNO_IFRAME_CSS } from "./highlight";
import { fontFaceCss } from "./reader-fonts";
import { useThemeStore } from "../store/theme-store";

const log = createLogger("epub");

interface Props {
  bookId: string;
  chapters: ChapterRefDto[];
}

const SAVE_DEBOUNCE_MS = 1000;
const CURRENT_EPUB_READ_CHARS = 4_000;

export function EpubReader({ bookId, chapters }: Props) {
  const { t } = useTranslation();
  const vRef = useRef<VirtualDocsHandle | null>(null);
  const [book, setBook] = useState<EpubBook | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);

  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const currentChapterId = useNavigationStore((s) => s.currentChapterId);
  const setCurrentChapter = useNavigationStore((s) => s.setCurrentChapter);
  const setReadingContext = useNavigationStore((s) => s.setReadingContext);
  const setReadingPercent = useNavigationStore((s) => s.setReadingPercent);
  const prefs = usePrefsStore((s) => s.prefs);
  const setSelection = useAnnotationStore((s) => s.setSelection);
  const openStyleBar = useAnnotationStore((s) => s.openStyleBar);
  const closeStyleBar = useAnnotationStore((s) => s.closeStyleBar);
  const scrollCommand = useAnnotationStore((s) => s.scrollCommand);
  const hoverHighlight = useNoteHoverStore((s) => s.hoverHighlight);
  const leaveHighlight = useNoteHoverStore((s) => s.leaveHighlight);
  const closeNoteHover = useNoteHoverStore((s) => s.closeNow);
  const qc = useQueryClient();

  // 防循环：记录最近一次「由滚动得出的顶部章 id」；跳章 effect 只在目标≠它时滚动。
  const topChapterIdRef = useRef<string | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const bytes = useQuery({
    queryKey: qk.bookBytes(bookId),
    queryFn: () => window.api.library.readBookBytes({ bookId }),
    staleTime: Infinity,
  });

  // 恢复位置：进度 locator（ePub 下为 CFI 串）→ spine index（开书时取一次）。
  const progress = useQuery({
    queryKey: qk.progress(bookId),
    queryFn: () => window.api.progress.get({ bookId }),
    staleTime: Infinity,
  });

  const annotations = useQuery({
    queryKey: qk.annotations(bookId),
    queryFn: () => window.api.annotations.listByBook({ bookId }),
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
        if (alive) {
          log.error("epub parse failed", err);
          setParseError(err instanceof Error ? err.message : String(err));
        }
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

  // 恢复初始位置：进度 locator → index（仅在 book+progress 就绪时算一次初值）。
  const initialIndex =
    book && progress.data?.locator != null
      ? (() => {
          const i = book.indexOfCfi(progress.data.locator);
          return i >= 0 ? i : 0;
        })()
      : 0;

  const onSelect = (e: SectionSelectEvent) => {
    const cfiRange = book ? book.cfiFromRange(e.index, e.range) : null;
    setSelection(sectionSelectToSelectionInfo(e, cfiRange));
  };
  const onSelectionCleared = () => setSelection(null);

  const chapterTextOffsetBeforeIndex = (chapterId: string, index: number): number => {
    let offset = 0;
    for (let i = 0; i < index; i++) {
      const href = book?.hrefAtIndex(i);
      if (href && chapterIdByHref(chapters, href) === chapterId)
        offset += book?.textLengthAtIndex(i) ?? 0;
    }
    return offset;
  };

  const onTopSectionChange = (index: number, meta: { scrollRatio: number }) => {
    if (!book) return;
    const percent = epubPercent(index, meta.scrollRatio, book.count);
    setReadingPercent(percent);
    // 当前章高亮
    const href = book.hrefAtIndex(index);
    const chId = href ? chapterIdByHref(chapters, href) : null;
    const ch = chId ? chapters.find((c) => c.id === chId) : null;
    const cfi = book.cfiAtIndex(index);
    if (chId) {
      const sectionLength = book.textLengthAtIndex(index);
      const offset =
        chapterTextOffsetBeforeIndex(chId, index) + Math.floor(sectionLength * meta.scrollRatio);
      setReadingContext({
        format: "epub",
        chapterId: chId,
        chapterTitle: ch?.title ?? null,
        offset,
        maxChars: CURRENT_EPUB_READ_CHARS,
        spineIndex: index,
        locator: cfi,
      });
    }
    if (chId) {
      topChapterIdRef.current = chId;
      if (chId !== currentChapterId) setCurrentChapter(chId);
    }
    // 防抖存进度（section 级 CFI）
    if (cfi) {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      saveTimer.current = setTimeout(() => {
        void window.api.progress
          .save({ bookId, locator: cfi, percent })
          .catch((err: unknown) => log.warn("save progress failed", err));
        // 同步写入查询缓存：progress 查询 staleTime=Infinity，不写缓存的话重开书会读到首开时
        // 的旧值（通常是 null）→ initialIndex 永远 0 → 回到开头。
        qc.setQueryData(qk.progress(bookId), { locator: cfi });
      }, SAVE_DEBOUNCE_MS);
    }
  };

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    },
    [],
  );

  const decorate = (index: number, doc: Document) => {
    if (book) applyAnnotations(book, annotations.data ?? [], index, doc);
  };
  const onHighlightClick = (
    annoId: string,
    rect: { x: number; y: number; width: number; height: number },
  ) => {
    openStyleBar({ rect, target: { type: "edit", annotationId: annoId } });
  };
  // 正文内任意 mousedown：关样式栏并清选区。二者一并 set（同一帧）→ 关栏后主工具栏不会因
  // selection 仍在而闪回。点高亮时此 mousedown 先关栏，随后的 click 再开该高亮的 edit 栏。
  const onContentMouseDown = () => {
    closeStyleBar();
    setSelection(null);
  };

  // 标注数据变化（建/改/删后 invalidate）→ 对在挂 section 重贴高亮。
  useEffect(() => {
    vRef.current?.redecorate();
  }, [annotations.data]);

  // 侧栏列表点击 → 滚到该标注所在 section（best-effort：稍后把 mark 滚入视口）。
  useEffect(() => {
    if (!book || !scrollCommand) return;
    const idx = book.indexOfCfi(scrollCommand.locator);
    if (idx >= 0) vRef.current?.scrollToIndex(idx);
  }, [book, scrollCommand]);

  // 滚动即放弃：工具栏/样式栏锚定于选区视口坐标，滚动后位置失真，故关样式栏并清选区。
  // 捕获阶段监听 document——scroll 不冒泡，但能捕获到 Virtuoso 滚动容器的滚动。
  useEffect(() => {
    const onScroll = () => {
      closeStyleBar();
      setSelection(null);
      closeNoteHover();
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [closeStyleBar, setSelection, closeNoteHover]);

  if (bytes.isError)
    return <ReaderError message={t("reader.epub.loadError", "无法读取此书的文件。")} />;
  if (parseError)
    return (
      <ReaderError
        message={t("reader.epub.parseError", "无法渲染此书：{{error}}", { error: parseError })}
      />
    );
  // 等字节+进度都就绪再挂 VirtualDocs，使 initialIndex 一次到位（避免先 0 再跳）。
  if (!book || progress.isLoading) {
    return (
      <div className="flex h-full items-center justify-center text-muted-foreground">
        {t("reader.epub.loading", "载入中…")}
      </div>
    );
  }

  return (
    <div className="h-full">
      <VirtualDocs
        ref={vRef}
        className="no-scrollbar"
        count={book.count}
        loadSection={book.loadSection}
        styleCss={
          fontFaceCss(prefs.fontFamily) +
          "\n" +
          prefsToCss(prefs) +
          "\n" +
          ANNO_IFRAME_CSS +
          "\n" +
          readerThemeCss(resolvedTheme === "dark")
        }
        initialIndex={initialIndex}
        onTopSectionChange={onTopSectionChange}
        onUnloadSection={(i) => book.unloadSection(i)}
        onSelect={onSelect}
        onSelectionCleared={onSelectionCleared}
        decorate={decorate}
        onHighlightClick={onHighlightClick}
        onHighlightHover={hoverHighlight}
        onHighlightLeave={leaveHighlight}
        onContentMouseDown={onContentMouseDown}
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
