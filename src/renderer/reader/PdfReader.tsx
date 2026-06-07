import { useEffect, useRef, useState } from "react";
import type { MouseEvent as ReactMouseEvent } from "react";
import { createLogger } from "@renderer/logger";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Virtuoso, type VirtuosoHandle } from "react-virtuoso";
import { cn } from "@renderer/lib/utils";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { useThemeStore } from "@renderer/store/theme-store";
import { useAnnotationStore } from "@renderer/store/annotation-store";
import { useNavigationStore } from "@renderer/store/navigation-store";
import type { ChapterRefDto } from "@shared/library";
import { qk } from "../query/keys";
import { createPdfBook, type PdfBook } from "./pdf-book";
import { makePdfLocator, parsePdfLocator, parsePdfLocatorRange } from "./pdf-locator";
import { pdfAnnosByPage, rangeFromOffsets, relativeRects } from "./pdf-annotations";
import { buildPdfSelectionInfo, flatOffsetOf, pointInDomSelection } from "./pdf-selection";
import { chapterIdAtPage } from "./pdf-chapter-at-page";
import { clampPdfZoom } from "./pdf-zoom";
import { findPdfTextLinks } from "./pdf-autolink";
import { OVERLAY_FILL } from "./highlight";
import type { PdfPageAnno } from "./pdf-annotations";
import { hitHighlight, usePdfHighlights } from "./use-pdf-highlights";

const log = createLogger("pdf");

interface Props {
  bookId: string;
  chapters: ChapterRefDto[];
}

const SAVE_DEBOUNCE_MS = 1000; // 对齐 EpubReader
/** 页列表左右留白（px）。 */
const PAGE_GUTTER = 48;

export function PdfReader({ bookId, chapters }: Props) {
  const { t } = useTranslation();
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const qc = useQueryClient();
  const [book, setBook] = useState<PdfBook | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  // 缩放倍率由顶栏 PdfPrefs 调整、落盘记忆；这里只读（clamp 防越界旧值）。
  const zoom = clampPdfZoom(usePrefsStore((s) => s.pdfZoom));
  const [containerW, setContainerW] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Virtuoso 挂载即触发一次 rangeChanged（含进度恢复时）——首发不是用户滚动，跳过免得无谓写库。
  const sawInitialRange = useRef(false);
  const currentChapterId = useNavigationStore((s) => s.currentChapterId);
  const setCurrentChapter = useNavigationStore((s) => s.setCurrentChapter);
  const setReadingContext = useNavigationStore((s) => s.setReadingContext);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  // Virtuoso 滚动容器（rangeChanged 里从 scrollTop 推视口顶部页用）。
  const scrollerRef = useRef<HTMLElement | null>(null);
  // 防循环：记录最近一次「由滚动得出的章 id」；跳章 effect 只在目标 ≠ 它时滚动（对齐 EpubReader）。
  const topChapterIdRef = useRef<string | null>(null);

  const setSelection = useAnnotationStore((s) => s.setSelection);
  const closeStyleBar = useAnnotationStore((s) => s.closeStyleBar);

  const bytes = useQuery({
    queryKey: qk.bookBytes(bookId),
    queryFn: () => window.api.library.readBookBytes({ bookId }),
    staleTime: Infinity,
  });

  // 恢复位置：进度 locator（pdf:JSON）→ 页 index（开书时取一次）。
  const progress = useQuery({
    queryKey: qk.progress(bookId),
    queryFn: () => window.api.progress.get({ bookId }),
    staleTime: Infinity,
  });

  // 标注：对齐 EpubReader 的 query 配置；建/改/删后 invalidate 自动重画。
  const annotations = useQuery({
    queryKey: qk.annotations(bookId),
    queryFn: () => window.api.annotations.listByBook({ bookId }),
    staleTime: Infinity,
  });
  const scrollCommand = useAnnotationStore((s) => s.scrollCommand);

  // 容器宽度（适宽缩放的输入）：ResizeObserver 跟踪。
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (!bytes.data) return;
    let alive = true;
    let created: PdfBook | null = null;
    setParseError(null);
    createPdfBook(bytes.data)
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
          log.error("pdf parse failed", err);
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

  // 组件卸载时清 timer（补充：bytes.data 未变化但卸载时确保清理）。
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  // 跳章：currentChapterId 变化（ChapterList 点击）→ 滚到章起始页。
  useEffect(() => {
    if (!book || currentChapterId == null) return;
    if (currentChapterId === topChapterIdRef.current) return; // 由滚动引起的同步，不回滚
    const ch = chapters.find((c) => c.id === currentChapterId);
    if (ch?.startPage == null) return;
    virtuosoRef.current?.scrollToIndex({ index: ch.startPage - 1, align: "start" });
  }, [book, currentChapterId, chapters]);

  // 侧栏标注列表点击 → 滚到标注所在页（对齐 EpubReader 的 scrollCommand 消费；
  // 非 pdf locator 解析为 null → no-op，与 ePub locator 互不串台）。
  useEffect(() => {
    if (!book || !scrollCommand) return;
    const r = parsePdfLocatorRange(scrollCommand.locator);
    if (r) virtuosoRef.current?.scrollToIndex({ index: r.page - 1, align: "start" });
  }, [book, scrollCommand]);

  // .selecting 清理挂 document 捕获：拖选释放在容器外（窗外/浮层上）时容器 onMouseUp
  // 不触发，class 残留会让该页链接层一直收不到 pointer 事件（链接永久不可点）。
  useEffect(() => {
    const clearSelecting = () => {
      containerRef.current
        ?.querySelectorAll(".textLayer.selecting")
        .forEach((el) => el.classList.remove("selecting"));
    };
    document.addEventListener("mouseup", clearSelecting, true);
    return () => document.removeEventListener("mouseup", clearSelecting, true);
  }, []);

  // 选区：textLayer 原生 DOM selection（同文档，无 iframe 桥）→ 页内偏移 + 字符窗口上下文。
  const onMouseUp = () => {
    const sel = document.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0) return;
    const range = sel.getRangeAt(0);
    const startEl =
      range.startContainer instanceof Element
        ? range.startContainer
        : range.startContainer.parentElement;
    const layer = startEl?.closest<HTMLElement>(".textLayer");
    if (!layer || !containerRef.current?.contains(layer)) return;
    const page = Number(layer.dataset.page);
    if (!Number.isInteger(page) || page < 1) return;
    const start = flatOffsetOf(layer, range.startContainer, range.startOffset);
    const endEl =
      range.endContainer instanceof Element ? range.endContainer : range.endContainer.parentElement;
    // 跨页选区：终点不在同一 textLayer → 偏移记不了（locatorRange null），仍可问 AI。
    const end =
      endEl?.closest(".textLayer") === layer
        ? flatOffsetOf(layer, range.endContainer, range.endOffset)
        : null;
    const r = range.getBoundingClientRect();
    setSelection(
      buildPdfSelectionInfo({
        page,
        pageStr: layer.textContent ?? "",
        start,
        end,
        selectionText: sel.toString(),
        rect: { x: r.x, y: r.y, width: r.width, height: r.height },
      }),
    );
  };
  // 正文 mousedown：关样式栏并清选区（对齐 EpubReader 的 onContentMouseDown——
  // P3 引入 styleBar 后若不关，残留的栏会让 SelectionToolbar 永久让位）。
  // 例外（对齐 virtual-docs SectionFrame.onContentDown）：点在已有选区内部 → 阻止默认
  // 塌缩、保留选区与 store，随后 mouseup 照常重建 SelectionInfo → 工具栏在新位置重弹
  // （滚动隐藏工具栏后，点回选区即可找回）。
  const onMouseDown = (e: ReactMouseEvent) => {
    if (pointInDomSelection(e.clientX, e.clientY)) {
      e.preventDefault();
      return;
    }
    const targetLayer = (e.target as Element | null)?.closest<HTMLElement>(".textLayer");
    targetLayer?.classList.add("selecting");
    closeStyleBar();
    setSelection(null);
  };

  // 滚动即放弃（对齐 EpubReader）：工具栏/样式栏锚定视口坐标，滚动后位置失真。
  // 捕获阶段监听 document——scroll 不冒泡，但能捕获到 Virtuoso 滚动容器的滚动。
  useEffect(() => {
    const onScroll = () => {
      closeStyleBar();
      setSelection(null);
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [closeStyleBar, setSelection]);

  const saveAt = (page: number) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const locator = makePdfLocator({ page, scrollRatio: 0 }); // 页级精度（页内比例留打磨期）
      void window.api.progress
        .save({ bookId, locator })
        .catch((err: unknown) => log.warn("save progress failed", err));
      qc.setQueryData(qk.progress(bookId), { locator });
    }, SAVE_DEBOUNCE_MS);
  };

  if (bytes.isError) {
    return <p className="p-6 font-sans text-sm text-destructive">{t("reader.epub.loadError")}</p>;
  }
  if (parseError) {
    return (
      <p className="p-6 font-sans text-sm text-destructive">
        {t("reader.pdf.parseError", "PDF 解析失败：{{error}}", { error: parseError })}
      </p>
    );
  }
  if (!book || progress.isPending || containerW === 0) {
    return (
      <div ref={containerRef} className="h-full">
        <p className="p-6 font-sans text-sm text-muted-foreground">{t("reader.epub.loading")}</p>
      </div>
    );
  }

  // 页 CSS 尺寸：适宽 × 档位。
  const pageW = Math.max(200, (containerW - PAGE_GUTTER) * zoom);
  const pageH = pageW * (book.baseSize.height / book.baseSize.width);

  // 标注按页分组（每渲染重算；可见页 × 条数级，开销可忽略——React Compiler 亦会缓存）。
  const annosByPage = pdfAnnosByPage(annotations.data ?? []);

  const initialPage = (() => {
    const loc = progress.data?.locator ? parsePdfLocator(progress.data.locator) : null;
    if (!loc) return 0;
    return Math.min(Math.max(loc.page - 1, 0), book.pageCount - 1);
  })();

  return (
    <div
      ref={containerRef}
      className="relative h-full"
      onMouseUp={onMouseUp}
      onMouseDown={onMouseDown}
    >
      <Virtuoso
        ref={virtuosoRef}
        scrollerRef={(el) => {
          scrollerRef.current = el instanceof HTMLElement ? el : null;
        }}
        className="no-scrollbar h-full"
        totalCount={book.pageCount}
        defaultItemHeight={pageH + 16}
        increaseViewportBy={{ top: pageH, bottom: pageH }}
        initialTopMostItemIndex={{ index: initialPage, align: "start" }}
        rangeChanged={(range) => {
          // rangeChanged 报告的是渲染范围——startIndex 含 increaseViewportBy 的 overscan
          // 预渲染页（CDP 实测视口顶页 125 时 startIndex 报 123），直接用会把当前章/进度
          // 偏到视口上方一页。从 scrollTop 推视口顶部页：每项高 pageH+16 均匀（v1 全书
          // 同尺寸前提）；+8px 把页间缝隙的归属切在缝隙中点，同时吸收跨页累计的亚像素误差。
          const scrollTop = scrollerRef.current?.scrollTop;
          const page =
            scrollTop != null
              ? Math.min(
                  book.pageCount,
                  Math.max(1, Math.floor((scrollTop + 8) / (pageH + 16)) + 1),
                )
              : range.startIndex + 1;
          // 当前章回写（含首发：开书恢复进度后侧栏即高亮正确章）。
          const chId = chapterIdAtPage(chapters, page);
          const ch = chId ? chapters.find((c) => c.id === chId) : null;
          setReadingContext({
            format: "pdf",
            page,
            pageCount: book.pageCount,
            chapterId: chId,
            chapterTitle: ch?.title ?? null,
          });
          if (chId) {
            topChapterIdRef.current = chId;
            if (chId !== currentChapterId) setCurrentChapter(chId);
          }
          if (!sawInitialRange.current) {
            sawInitialRange.current = true;
            return; // 首发非用户滚动，不写进度
          }
          saveAt(page);
        }}
        // 缩放换档时 key 变化 → 可视页整体重挂（拿到新 canvas，满足 pdf-book 同 canvas 约束）。
        // v1 接受全量重挂；离屏页经 cssWidth dep 自然重渲。
        computeItemKey={(index) => `${index}-${Math.round(pageW)}`}
        itemContent={(index) => (
          <PdfPage
            book={book}
            index={index}
            cssWidth={pageW}
            cssHeight={pageH}
            invert={resolvedTheme === "dark"}
            annos={annosByPage.get(index + 1) ?? []}
            onLinkPage={(pageNumber) =>
              virtuosoRef.current?.scrollToIndex({ index: pageNumber - 1, align: "start" })
            }
          />
        )}
      />
    </div>
  );
}

/** 单页：canvas + 高亮 overlay + textLayer 三层叠放；卸载/参数变化取消未完成渲染。 */
function PdfPage(props: {
  book: PdfBook;
  index: number;
  cssWidth: number;
  cssHeight: number;
  invert: boolean;
  annos: PdfPageAnno[];
  onLinkPage: (pageNumber: number) => void;
}) {
  const { book, index, cssWidth, cssHeight, invert, annos, onLinkPage } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const annotationLayerRef = useRef<HTMLDivElement | null>(null);
  const autoLinkLayerRef = useRef<HTMLDivElement | null>(null);
  const [renderError, setRenderError] = useState(false);
  // renderPage done = canvas+textLayer 两路都 settle → 偏移可以安全还原成 Range。
  const [textReady, setTextReady] = useState(false);
  const openStyleBar = useAnnotationStore((s) => s.openStyleBar);
  const highlights = usePdfHighlights(annos, textLayerRef.current, textReady);
  const [autoLinks, setAutoLinks] = useState<PdfAutoLink[]>([]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setRenderError(false);
    setTextReady(false);
    // stale 守卫：cancel 时 done 也 resolve（pdf-book 契约）——effect 重跑后旧 task 的
    // then 绝不能再碰 state，否则会在新渲染完成前把 textReady 抢先置 true 且永不纠正。
    let stale = false;
    const task = book.renderPage(
      index,
      canvas,
      cssWidth,
      textLayerRef.current ?? undefined,
      annotationLayerRef.current ?? undefined,
      onLinkPage,
    );
    task.done
      .then(() => {
        if (!stale) {
          setAutoLinks(buildPdfAutoLinks(textLayerRef.current, autoLinkLayerRef.current));
          setTextReady(true);
        }
      })
      .catch(() => {
        if (!stale) setRenderError(true);
      });
    return () => {
      stale = true;
      task.cancel();
    };
  }, [book, index, cssWidth]);

  // 点击命中高亮 → 编辑样式栏（对齐 ePub onHighlightClick）。视觉矩形 pointer-events-none
  // 不挡划词；命中测试走容器 click——选区未塌缩 = 拖选结尾，不当点击。
  const onClick = (e: ReactMouseEvent) => {
    if ((e.target as Element | null)?.closest(".annotationLayer")) return;
    if (!(window.getSelection()?.isCollapsed ?? true)) return;
    const layer = textLayerRef.current;
    if (!layer || highlights.length === 0) return;
    const base = layer.getBoundingClientRect();
    const hit = hitHighlight(highlights, e.clientX - base.x, e.clientY - base.y);
    if (!hit) return;
    openStyleBar({
      rect: {
        x: hit.rect.left + base.x,
        y: hit.rect.top + base.y,
        width: hit.rect.width,
        height: hit.rect.height,
      },
      target: { type: "edit", annotationId: hit.annoId },
    });
  };

  // hover 可点击目标（标注高亮 / 活跃选区）→ pointer cursor（对齐 ePub：mark.anno 的
  // cursor:pointer + SectionFrame 选区 hover 手型）。overlay 不接事件（不挡划词），改在
  // 容器 mousemove 命中测试；直写 data 属性（零重渲染），CSS 据此切 span 的 cursor——
  // 指针仅一处，整层切换在视觉上即「目标区域内变 pointer」。
  const onMouseMove = (e: ReactMouseEvent) => {
    const layer = textLayerRef.current;
    if (!layer) return;
    let over = pointInDomSelection(e.clientX, e.clientY);
    if (!over && highlights.length > 0) {
      const base = layer.getBoundingClientRect();
      over = hitHighlight(highlights, e.clientX - base.x, e.clientY - base.y) !== undefined;
    }
    if (over) layer.setAttribute("data-pointer", "");
    else layer.removeAttribute("data-pointer");
  };
  const onMouseLeave = () => textLayerRef.current?.removeAttribute("data-pointer");

  return (
    // w-max + min-w-full：页宽超过视口（高缩放）时外壳随内容撑开（横向可滚、左缘可达），
    // 未超时占满视口居中。shrink-0 禁止 flex 把超宽页压回容器宽——否则只有纵向放大（比例失调）。
    <div className="flex w-max min-w-full justify-center py-2">
      {renderError ? (
        <div
          className="flex shrink-0 items-center justify-center bg-muted font-sans text-xs text-muted-foreground"
          // 运行时计算的页面尺寸（规范允许内联承载运行时值）
          style={{ width: cssWidth, height: cssHeight }}
        >
          ⚠ p.{index + 1}
        </div>
      ) : (
        <div
          className="relative shrink-0 shadow-sm"
          style={{ width: cssWidth, height: cssHeight }}
          onClick={onClick}
          onMouseMove={onMouseMove}
          onMouseLeave={onMouseLeave}
        >
          <canvas
            ref={canvasRef}
            className={cn("h-full w-full", invert && "[filter:invert(1)_hue-rotate(180deg)]")}
          />
          {/* 高亮 overlay：canvas 之上、textLayer 之下；纯视觉不接事件（不挡原生划词）。 */}
          <div className="pointer-events-none absolute inset-0">
            {highlights.map((h) => (
              <div
                key={`${h.annoId}-${Math.round(h.rect.left)}-${Math.round(h.rect.top)}`}
                className={cn("absolute", OVERLAY_FILL[h.style])}
                // 运行时计算的矩形几何
                style={{
                  left: h.rect.left,
                  top: h.rect.top,
                  width: h.rect.width,
                  height: h.rect.height,
                }}
              />
            ))}
          </div>
          {/* data-page：选区处理据此识别页号（1-based）。invert 滤镜只作用于 canvas。 */}
          <div ref={textLayerRef} data-page={index + 1} className="textLayer" />
          <div ref={annotationLayerRef} className="annotationLayer" />
          <div ref={autoLinkLayerRef} className="pdfAutoLinkLayer">
            {autoLinks.map((link) => (
              <a
                key={`${link.href}-${Math.round(link.rect.left)}-${Math.round(link.rect.top)}`}
                className="autoLinkAnnotation"
                href={link.href}
                target="_blank"
                rel="noopener noreferrer nofollow"
                title={link.href}
                style={{
                  left: link.rect.left,
                  top: link.rect.top,
                  width: link.rect.width,
                  height: link.rect.height,
                }}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

interface PdfAutoLink {
  href: string;
  rect: { left: number; top: number; width: number; height: number };
}

function buildPdfAutoLinks(
  textLayer: HTMLDivElement | null,
  annotationLayer: HTMLDivElement | null,
): PdfAutoLink[] {
  if (!textLayer || !annotationLayer) return [];
  const text = textLayer.textContent ?? "";
  const base = annotationLayer.getBoundingClientRect();
  const out: PdfAutoLink[] = [];
  for (const link of findPdfTextLinks(text)) {
    const range = rangeFromOffsets(textLayer, link.start, link.end);
    if (!range) continue;
    for (const rect of relativeRects(range.getClientRects(), base)) {
      out.push({ href: link.href, rect });
    }
  }
  return out;
}
