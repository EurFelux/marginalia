import { useEffect, useRef } from "react";
import { useTranslation } from "react-i18next";
import { createLogger } from "@renderer/logger";
import { useQuery } from "@tanstack/react-query";
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
import { pickAnchorChapterId } from "./current-anchor-chapter";
import { useEpubSession } from "./epub-session";
import { BookFileMissingPanel } from "./BookFileMissingPanel";
import { epubPercent } from "./percent";
import { prefsToCss } from "./prefs-to-css";
import { readerThemeCss } from "./reader-theme-css";
import { sectionSelectToSelectionInfo } from "./epub-selection";
import { applyAnnotations } from "./apply-annotations";
import { ANNO_IFRAME_CSS } from "./highlight";
import { fontFaceCss } from "./reader-fonts";
import { useThemeStore } from "../store/theme-store";
import { ttsController } from "./tts/tts-controller";
import { TTS_IFRAME_CSS } from "./tts/tts-css";
import { readableTextOffsetAtRange, readableTextRangeAtY } from "./epub-text-position";
import { useReadingPosition } from "./use-reading-position";
import type { ReadingPosition } from "./reading-position-machine";

const log = createLogger("epub");

interface Props {
  bookId: string;
  chapters: ChapterRefDto[];
  persistProgress: boolean;
}

const CURRENT_EPUB_READ_CHARS = 4_000;

export function EpubReader({ bookId, chapters, persistProgress }: Props) {
  const { t } = useTranslation();
  const vRef = useRef<VirtualDocsHandle | null>(null);
  const { book, parseError, bytesError, bytesMissing } = useEpubSession();

  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const currentChapterId = useNavigationStore((s) => s.currentChapterId);
  const setCurrentChapter = useNavigationStore((s) => s.setCurrentChapter);
  const setReadingContext = useNavigationStore((s) => s.setReadingContext);
  const prefs = usePrefsStore((s) => s.prefs);
  const setSelection = useAnnotationStore((s) => s.setSelection);
  const openStyleBar = useAnnotationStore((s) => s.openStyleBar);
  const closeStyleBar = useAnnotationStore((s) => s.closeStyleBar);
  const scrollCommand = useAnnotationStore((s) => s.scrollCommand);
  const hoverHighlight = useNoteHoverStore((s) => s.hoverHighlight);
  const leaveHighlight = useNoteHoverStore((s) => s.leaveHighlight);
  const closeNoteHover = useNoteHoverStore((s) => s.closeNow);

  // 防循环：记录最近一次「由滚动得出的顶部章 id」；跳章 effect 只在目标≠它时滚动。
  const topChapterIdRef = useRef<string | null>(null);
  // TTS 起读用：最近一次滚动得出的顶部 section 索引。
  const topSectionIndexRef = useRef(0);
  // 当前 Range 无法映射到文本坐标时只告警一次，避免滚动产生日志风暴。
  const offsetFallbackWarnedRef = useRef(false);

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

  // book 生命周期已提升到 EpubSessionProvider；reader 自有状态的「切书重置」改由此处接管。
  useEffect(() => {
    topChapterIdRef.current = null;
    topSectionIndexRef.current = 0;
    offsetFallbackWarnedRef.current = false;
  }, [bookId]);

  // cfiFromElement 生成的「指向元素」CFI 末段带 [id] 断言；epubjs toRange 对这类 point CFI 常返回
  // null（"No startContainer found"），故取最后一个 [id] 断言作锚点元素 id 兜底。
  const resolveCfiElement = (cfi: string) => (doc: Document) => {
    if (!book) return null;
    const idAssertion = [...cfi.matchAll(/\[([^\]]+)\]/g)].at(-1)?.[1] ?? null;
    // 先试 rangeFromCfi（标注的 range CFI 走这条精确路）；失败再用 [id] 断言 getElementById（进度恢复）。
    const node = book.rangeFromCfi(cfi, doc)?.startContainer ?? null;
    const fromRange = node ? (node.nodeType === 1 ? (node as Element) : node.parentElement) : null;
    return fromRange ?? (idAssertion ? doc.getElementById(idAssertion) : null);
  };

  const resolveChapterTarget = (chapterId: string) => {
    const ch = chapters.find((c) => c.id === chapterId);
    if (!ch || !book) return null;
    const index = book.indexOfHref(ch.href);
    return index < 0 ? null : { index, anchor: ch.anchor ?? null };
  };

  const reportPosition = (position: ReadingPosition) => {
    if (position.chapterId == null) return;
    setReadingContext({
      format: "epub",
      chapterId: position.chapterId,
      chapterTitle: position.chapterTitle,
      offset: position.offset,
      maxChars: CURRENT_EPUB_READ_CHARS,
      spineIndex: position.index,
      locator: position.cfi,
    });
    topChapterIdRef.current = position.chapterId;
    if (position.chapterId !== currentChapterId) setCurrentChapter(position.chapterId);
  };

  const { raise } = useReadingPosition({
    bookId,
    book,
    persistProgress,
    vRef,
    resolveCfiElement,
    resolveChapterTarget,
    reportPosition,
  });

  // 跳章：currentChapterId 变化（ChapterList 点击）→ 滚到对应 spine index（锚点级）。
  useEffect(() => {
    if (currentChapterId == null) return;
    if (currentChapterId === topChapterIdRef.current) return; // 由滚动引起的同步，不回滚
    raise({ type: "CHAPTER_REQUESTED", chapterId: currentChapterId });
  }, [currentChapterId, raise]);

  // 恢复初始位置：进度 locator → section index（initialIndex 让 VirtualDocs 首挂即落在正确 section），
  // 再由状态机发起锚点级精确定位（initialIndex 只到 section 顶，对「一个 section 几十章」的书等于回开头）。
  const initialIndex =
    book && progress.data?.locator != null
      ? (() => {
          const i = book.indexOfCfi(progress.data.locator);
          return i >= 0 ? i : 0;
        })()
      : 0;

  useEffect(() => {
    if (!book || progress.isLoading) return;
    const locator = progress.data?.locator ?? null;
    const target = locator == null ? -1 : book.indexOfCfi(locator);
    raise({ type: "SESSION_READY", locator, targetIndex: target >= 0 ? target : null });
  }, [book, progress.isLoading, progress.data?.locator, raise]);

  // TTS：book 就绪即挂接上下文；卸载/换书 detach（内部停止朗读并清高亮）。
  useEffect(() => {
    if (!book) return;
    ttsController.attach({
      sectionCount: book.count,
      getTopSectionIndex: () => topSectionIndexRef.current,
      scrollToSection: (i) => vRef.current?.scrollToIndex(i),
      getScroller: () => vRef.current?.getScrollerElement() ?? null,
    });
    return () => ttsController.detach();
  }, [book]);

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
        offset += book?.chapterTextLengthAtIndex(i) ?? 0;
    }
    return offset;
  };

  const stripFrag = (h: string) => h.split("#")[0]!;
  // 取末段文件名：epubjs 的 section.href 是 OPF 内裸形（text00000.html），DB chapter.href 带 OPF 目录
  // 前缀（OEBPS/text00000.html）——精确比对永不命中，须按 basename 归属 section（与 chapter-id-by-href 对称）。
  const basenameOf = (h: string) => {
    const p = stripFrag(h);
    return p.slice(p.lastIndexOf("/") + 1);
  };

  const onTopSectionChange = (index: number, meta: { scrollRatio: number }) => {
    if (!book) return;
    topSectionIndexRef.current = index;
    // 当前章高亮（锚点级）
    const anchorChapterIdAt = (sectionIndex: number): string | null => {
      const sHref = book.hrefAtIndex(sectionIndex);
      if (!sHref) return null;
      const sBase = basenameOf(sHref);
      const sectionChs = chapters
        .filter((c) => basenameOf(c.href) === sBase)
        .filter((c) => c.anchor);
      if (sectionChs.length === 0) return chapterIdByHref(chapters, sHref); // 无锚点章退回 href 级
      const frame = document.querySelector<HTMLIFrameElement>(
        `[data-section-index="${sectionIndex}"] iframe`,
      );
      const doc = frame?.contentDocument;
      const docRoot = doc?.documentElement;
      if (!doc || !docRoot) return chapterIdByHref(chapters, sHref);
      const docTop = docRoot.getBoundingClientRect().top;
      const positions = sectionChs
        .map((c) => {
          const el = c.anchor ? doc.getElementById(c.anchor) : null;
          return el
            ? { id: c.id, anchor: c.anchor!, top: el.getBoundingClientRect().top - docTop }
            : null;
        })
        .filter((x): x is { id: string; anchor: string; top: number } => x !== null)
        .sort((a, b) => a.top - b.top);
      const sectionHeight = book.textLengthAtIndex(sectionIndex) ? docRoot.scrollHeight : 0;
      const viewportTop = sectionHeight * meta.scrollRatio;
      return pickAnchorChapterId(positions, viewportTop) ?? chapterIdByHref(chapters, sHref);
    };

    const chId = anchorChapterIdAt(index);
    const ch = chId ? chapters.find((c) => c.id === chId) : null;

    // 像素级进度：取「视口顶部那个块级元素」，存其首字符的 range CFI（range CFI 才能被 rangeFromCfi
    // 在恢复时精确还原；cfiFromElement 的 point CFI 在恢复时 toRange 解析不出）。退化到 section 起点 CFI。
    const topReadablePosition = (
      sectionIndex: number,
    ): { cfi: string; textOffset: number | null } => {
      const fallback = book!.cfiAtIndex(sectionIndex) ?? "";
      const frame = document.querySelector<HTMLIFrameElement>(
        `[data-section-index="${sectionIndex}"] iframe`,
      );
      const doc = frame?.contentDocument;
      const scroller = vRef.current?.getScrollerElement() ?? null;
      if (!doc?.documentElement || !frame || !scroller) return { cfi: fallback, textOffset: null };
      // 视口顶在该 section 文档内的 y：scroller 顶（主坐标）− iframe 顶（主坐标）。iframe 不内部滚动，
      // 故块元素 getBoundingClientRect().top 即其 doc 内 offsetTop，可直接与之比较。
      const targetInDoc = scroller.getBoundingClientRect().top - frame.getBoundingClientRect().top;
      const range = readableTextRangeAtY(doc, targetInDoc);
      if (!range) return { cfi: fallback, textOffset: null };
      return {
        cfi: book!.cfiFromRange(sectionIndex, range) ?? fallback,
        textOffset: readableTextOffsetAtRange(doc, range),
      };
    };

    const { cfi, textOffset } = topReadablePosition(index);
    if (
      textOffset == null &&
      book.textLengthAtIndex(index) > 0 &&
      !offsetFallbackWarnedRef.current
    ) {
      offsetFallbackWarnedRef.current = true;
      log.warn(`text offset unavailable; using section scroll ratio: ${index}`);
    }
    const percent = epubPercent(index, textOffset, book.textLengths, meta.scrollRatio);
    // 锚点章 = 整 spine 文件里的一小片（正文从锚点切到下一锚点），整章一次 readChapterText 即读全 →
    // offset 从 0 起。section 相对 offset（= 在整个大文件里的字符位置）对锚点章无意义：会远超章长、
    // 取到空文本，使「读我当前位置」的 AI 工具拿不到内容。无锚点的整文件章仍用 section 相对 offset。
    const sectionLength = book.chapterTextLengthAtIndex(index);
    const offset =
      chId == null
        ? 0
        : ch?.anchor
          ? 0
          : chapterTextOffsetBeforeIndex(chId, index) +
            Math.floor(sectionLength * meta.scrollRatio);
    raise({
      type: "TOP_SECTION_CHANGED",
      position: {
        index,
        scrollRatio: meta.scrollRatio,
        cfi,
        percent,
        chapterId: chId,
        chapterTitle: ch?.title ?? null,
        offset,
      },
    });
  };

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

  const onInternalLink = ({ index, href }: { index: number; href: string }) => {
    if (!book) return;
    const hash = href.indexOf("#");
    const anchor = hash >= 0 ? href.slice(hash + 1) : "";
    // 纯 fragment（#x，无路径）→ 当前 section 内；带路径 → resolve 到目标 section。
    const targetIdx = href.startsWith("#") ? index : book.indexOfHref(href);
    if (targetIdx < 0) {
      log.warn(`internal link target not found: ${href}`);
      return;
    }
    if (anchor) void vRef.current?.scrollToAnchor(targetIdx, anchor);
    else vRef.current?.scrollToIndex(targetIdx);
  };
  const onExternalLink = (url: string) => {
    void window.api.app
      .openExternal({ url })
      .catch((err: unknown) => log.warn("open external failed", err));
  };

  // 侧栏列表点击 → 精确滚到该标注（锚点级：CFI 解析回元素，不再只到 section 顶）。
  useEffect(() => {
    if (!scrollCommand) return;
    raise({ type: "ANNOTATION_SCROLL", locator: scrollCommand.locator });
  }, [scrollCommand, raise]);

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

  if (bytesMissing) return <BookFileMissingPanel bookId={bookId} />;
  if (bytesError)
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
        sectionWeight={book.textLengthAtIndex}
        initialPxPerWeight={0.1}
        styleCss={
          fontFaceCss(prefs.fontFamily) +
          "\n" +
          prefsToCss(prefs) +
          "\n" +
          ANNO_IFRAME_CSS +
          "\n" +
          readerThemeCss(resolvedTheme === "dark") +
          "\n" +
          TTS_IFRAME_CSS
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
        onUserNavigation={() => raise({ type: "USER_NAVIGATED" })}
        onTransition={(r) => log.debug("viewport transition", r)}
        onInternalLink={onInternalLink}
        onExternalLink={onExternalLink}
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
