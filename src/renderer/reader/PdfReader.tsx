import { useEffect, useLayoutEffect, useRef, useState } from "react";
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
import { BookFileMissingPanel } from "./BookFileMissingPanel";
import { makePdfLocator, parsePdfLocator, parsePdfLocatorRange } from "./pdf-locator";
import { pdfAnnosByPage, rangeFromOffsets, relativeRects } from "./pdf-annotations";
import { buildPdfSelectionInfo, flatOffsetOf, pointInDomSelection } from "./pdf-selection";
import { chapterIdAtPage } from "./pdf-chapter-at-page";
import { clampPdfZoom, nextZoom } from "./pdf-zoom";
import { pdfPercent } from "./percent";
import {
  intraPageRatio,
  scrollTopFor,
  topPageAt,
  zoomScrollLeft,
  zoomScrollOffset,
} from "./pdf-scroll";
import { findPdfTextLinks } from "./pdf-autolink";
import { overlayClass } from "./highlight";
import type { PdfPageAnno } from "./pdf-annotations";
import { hitHighlight, usePdfHighlights } from "./use-pdf-highlights";
import { useNoteHoverStore } from "@renderer/store/note-hover-store";

const log = createLogger("pdf");

interface Props {
  bookId: string;
  chapters: ChapterRefDto[];
  persistProgress: boolean;
}

const SAVE_DEBOUNCE_MS = 1000; // 对齐 EpubReader
/** 页列表左右留白（px）。 */
const PAGE_GUTTER = 48;
/** 相邻两次缩放提交间隔 ≤ 此值视为「同一手势」（捏合连续 wheel/快速连点）——锚点不重捕获。 */
const ZOOM_GESTURE_GAP_MS = 250;
/** 同页缩放重渲的 debounce：停止缩放此毫秒后才渲到新分辨率；过程中 CSS 拉伸旧画面（不闪不卡）。 */
const RENDER_DEBOUNCE_MS = 140;

export function PdfReader({ bookId, chapters, persistProgress }: Props) {
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
  // initialScrollTop 非 0 时 Virtuoso 先按 scrollTop=0 渲染、再 rAF 滚到目标 → 初始会触发两次：
  // 首发被本守卫拦下，第二次会把刚加载的 locator 幂等回写一次（同值，已知取舍、可接受）。
  const sawInitialRange = useRef(false);
  const currentChapterId = useNavigationStore((s) => s.currentChapterId);
  const setCurrentChapter = useNavigationStore((s) => s.setCurrentChapter);
  const setReadingContext = useNavigationStore((s) => s.setReadingContext);
  const setReadingPercent = useNavigationStore((s) => s.setReadingPercent);
  const virtuosoRef = useRef<VirtuosoHandle | null>(null);
  // Virtuoso 滚动容器（rangeChanged 里从 scrollTop 推视口顶部页用）。
  const scrollerRef = useRef<HTMLElement | null>(null);
  // 防循环：记录最近一次「由滚动得出的章 id」；跳章 effect 只在目标 ≠ 它时滚动（对齐 EpubReader）。
  const topChapterIdRef = useRef<string | null>(null);

  // 页 CSS 尺寸：适宽 × 档位。上移到 early-return 之前供缩放 hooks 使用；
  // book 未就绪时 pageH=0，相关 effect 以此守卫。
  const pageW = Math.max(200, (containerW - PAGE_GUTTER) * zoom);
  const pageH = book ? pageW * (book.baseSize.height / book.baseSize.width) : 0;

  const setSelection = useAnnotationStore((s) => s.setSelection);
  const closeStyleBar = useAnnotationStore((s) => s.closeStyleBar);
  const closeNoteHover = useNoteHoverStore((s) => s.closeNow);

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
  // 依赖 bytes.data?.ok：缺失态会先 early-return 出 BookFileMissingPanel（containerRef 容器未挂载），
  // 若只在 mount observe 一次会拿到 null 而永久放弃观察；relink 恢复（ok:false→true）后容器才挂载，
  // 故随 ok 变化重跑、重新 observe 当前容器，避免 containerW 永久为 0 卡死「加载中」。
  // （loading↔loaded 间容器复用同一 DOM——见下方 onWheel effect 注释——故不必每次都重挂。）
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setContainerW(el.clientWidth));
    ro.observe(el);
    setContainerW(el.clientWidth);
    return () => ro.disconnect();
  }, [bytes.data?.ok]);

  useEffect(() => {
    if (!bytes.data?.ok) return;
    const fileBytes = bytes.data.data;
    let alive = true;
    let created: PdfBook | null = null;
    setParseError(null);
    createPdfBook(fileBytes)
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
    const onScroll = (e: Event) => {
      const scroller = scrollerRef.current;
      if (scroller && e.target === scroller) {
        // 缩放复位用的「缩放前 scrollTop」快照（用户主动滚动时持续刷新）。
        lastScrollTopRef.current = scroller.scrollTop;
        lastScrollLeftRef.current = scroller.scrollLeft;
      }
      closeStyleBar();
      setSelection(null);
      closeNoteHover();
    };
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [closeStyleBar, setSelection, closeNoteHover]);

  const saveAt = (page: number, scrollRatio: number, percent: number) => {
    if (!persistProgress) return;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const locator = makePdfLocator({ page, scrollRatio });
      void window.api.progress
        .save({ bookId, locator, percent })
        .catch((err: unknown) => log.warn("save progress failed", err));
      qc.setQueryData(qk.progress(bookId), { locator });
    }, SAVE_DEBOUNCE_MS);
  };

  const setPdfZoom = usePrefsStore((s) => s.setPdfZoom);
  // Ctrl+滚轮 / 触控板捏合缩放（捏合 wheel 事件 ctrlKey=true）：精确目标存 ref
  // （不过 1% 取整，防慢速捏合被取整卡死），rAF 每帧最多提交一次。缩放后由下方
  // useLayoutEffect 统一复位滚动；wheel 只记录锚点 = 光标在视口内的 (x, y)。
  const zoomTargetRef = useRef(zoom);
  // wheel/捏合的光标视口像素（仅 x/y）。page/ratio 不在事件里算——见下方「手势锚点」。
  const zoomAnchorRef = useRef<{ anchorX: number; anchorY: number } | null>(null);
  const zoomRafRef = useRef(0);
  // 复位用「缩放前」几何：仅当 zoom 真正变化（非窗口 resize）才以锚点复位。
  const prevPageHRef = useRef(pageH);
  const prevZoomRef = useRef(zoom);
  // 缩放「手势」锚点：连续缩放（相邻提交间隔 < 阈值）视为同一手势，锚点（内容点 + 视口像素 + 起始
  // 几何）只在手势第一帧锁定一次、之后固定不变；每帧纯 scrollToIndex 复位到它。绝不每帧重读 live
  // scrollTop / pageH——连续捏合时 scrollToIndex 异步生效、pageH 经 React state 逐帧推进，两者错位
  // 才是「连续缩放页号漂移」的真根因（与 Virtuoso 改 scrollTop 无关）。
  const zoomGestureRef = useRef<{
    page: number;
    ratio: number;
    anchorX: number;
    anchorY: number;
    baseScrollLeft: number;
    basePageH: number;
  } | null>(null);
  const lastZoomAtRef = useRef(0);
  // 滚动快照（缩放手势开始前最后的稳定 scrollTop/Left）：手势第一帧据此 + oldPageH 锁定锚点内容点，
  // 不读 layout effect 时刻可能已滞后于 pageH 的 live scrollTop。由 scroll 事件与 rangeChanged 维护。
  const lastScrollTopRef = useRef(0);
  const lastScrollLeftRef = useRef(0);

  // 外部改缩放（PdfPrefs 按钮/输入框）→ 重新 seed 精确目标；自家提交（恒 = clamp(target)）
  // 不触发，保留 1% 以下精度。
  useEffect(() => {
    if (Math.abs(zoom - clampPdfZoom(zoomTargetRef.current)) > 1e-6) {
      zoomTargetRef.current = zoom;
    }
  }, [zoom]);

  // React 合成 onWheel 是 passive 的（preventDefault 拦不住浏览器缩放）→ 原生监听。
  // 挂 containerRef 而非 Virtuoso scrollerRef：容器跨 loading→loaded 稳定存在，
  // 滚轮事件自 scroller 冒泡可达，且 scroller h-full 占满容器、坐标系一致。
  // 只记录光标视口像素 + 提交目标缩放；锚点内容点的锁定与复位交给下方手势 useLayoutEffect。
  useEffect(() => {
    const container = containerRef.current;
    if (!book || !container) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      const rect = container.getBoundingClientRect();
      zoomTargetRef.current = nextZoom(zoomTargetRef.current, e.deltaY);
      zoomAnchorRef.current = { anchorX: e.clientX - rect.left, anchorY: e.clientY - rect.top };
      if (!zoomRafRef.current) {
        zoomRafRef.current = requestAnimationFrame(() => {
          zoomRafRef.current = 0;
          setPdfZoom(clampPdfZoom(zoomTargetRef.current));
        });
      }
    };
    container.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      container.removeEventListener("wheel", onWheel);
      if (zoomRafRef.current) {
        cancelAnimationFrame(zoomRafRef.current);
        zoomRafRef.current = 0;
      }
    };
  }, [book, setPdfZoom]);

  // 缩放提交后统一复位滚动（锚点 = 光标处 / 视口中心），覆盖三条路径（滚轮·捏合·按钮·输入框）。
  // 关键：竖向用 Virtuoso 自身 scrollToIndex 命令复位，而非裸 scroller.scrollTop——后者会被
  // Virtuoso 的 resize 重新落位（auto-resizing）随后冲掉（旧实现三路全跳的根因）。横向不归
  // Virtuoso 管，直接设 scrollLeft。仅在 zoom 真正变化时复位：窗口 resize（pageH 变但 zoom 不变）
  // 交给 Virtuoso 默认顶部锚定。scroller.scrollTop 在本 layout effect 时仍是缩放前值（Virtuoso
  // 的 resize 回调晚于此），据此 + oldPageH 反推锚点所在页/页内比例。
  useLayoutEffect(() => {
    const oldPageH = prevPageHRef.current;
    const zoomChanged = Math.abs(zoom - prevZoomRef.current) > 1e-9;
    prevPageHRef.current = pageH;
    prevZoomRef.current = zoom;
    const wheelPx = zoomAnchorRef.current;
    zoomAnchorRef.current = null;

    if (!book || !zoomChanged || pageH <= 0 || oldPageH <= 0 || pageH === oldPageH) return;
    const scroller = scrollerRef.current;
    const virtuoso = virtuosoRef.current;
    if (!scroller || !virtuoso) return;

    const now = performance.now();
    const newGesture = now - lastZoomAtRef.current > ZOOM_GESTURE_GAP_MS || !zoomGestureRef.current;
    lastZoomAtRef.current = now;
    if (newGesture) {
      // 手势第一帧：用「缩放前」几何（oldPageH + 滚动快照）把锚点内容点 (page, ratio) 与视口像素锁定。
      // 锚点 = 光标处（wheel/捏合）或视口中心（按钮/输入框）。
      const anchorX = wheelPx?.anchorX ?? scroller.clientWidth / 2;
      const anchorY = wheelPx?.anchorY ?? scroller.clientHeight / 2;
      const absY = lastScrollTopRef.current + anchorY;
      const page = topPageAt(absY, oldPageH, book.pageCount);
      zoomGestureRef.current = {
        page,
        ratio: intraPageRatio(absY, page, oldPageH),
        anchorX,
        anchorY,
        baseScrollLeft: lastScrollLeftRef.current,
        basePageH: oldPageH,
      };
    }
    const g = zoomGestureRef.current;
    if (!g) return;
    // 每帧把同一锚点内容点钉回同一视口像素：竖向走 Virtuoso 自身命令、横向直接设 scrollLeft。
    // 不读 live scrollTop → 免疫连续缩放的 scrollToIndex 异步 / pageH 逐帧推进错位。
    virtuoso.scrollToIndex({
      index: g.page - 1,
      align: "start",
      offset: zoomScrollOffset(g.ratio, pageH, g.anchorY),
    });
    scroller.scrollLeft = zoomScrollLeft(g.baseScrollLeft, g.anchorX, pageH / g.basePageH);
  }, [pageH, zoom, book]);

  if (bytes.data?.ok === false) return <BookFileMissingPanel bookId={bookId} />;
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

  // 标注按页分组（每渲染重算；可见页 × 条数级，开销可忽略——React Compiler 亦会缓存）。
  const annosByPage = pdfAnnosByPage(annotations.data ?? []);

  // 恢复位置：页 + 页内比例 → 精确 scrollTop（全书同尺寸直接算，无挂载后跳动）。
  // 首页页顶特判回 0：scrollTopFor(1, 0) = 8px（py-2 上缝），别让书首露半截缝。
  const initialScrollTop = (() => {
    const loc = progress.data?.locator ? parsePdfLocator(progress.data.locator) : null;
    if (!loc) return 0;
    const page = Math.min(Math.max(loc.page, 1), book.pageCount);
    const ratio = Math.min(Math.max(loc.scrollRatio, 0), 1);
    return page === 1 && ratio === 0 ? 0 : scrollTopFor(page, ratio, pageH);
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
        initialScrollTop={initialScrollTop}
        rangeChanged={(range) => {
          // rangeChanged 报告的是渲染范围——startIndex 含 increaseViewportBy 的 overscan
          // 预渲染页（CDP 实测视口顶页 125 时 startIndex 报 123），直接用会把当前章/进度
          // 偏到视口上方一页。从 scrollTop 推视口顶部页与页内比例（全书同尺寸前提，
          // 几何换算见 pdf-scroll.ts）。不变量：page/ratio 必须由「实时 scrollTop × 实时
          // pageH」现算——缩放复位后才触发本回调（rAF 滞后于 layout effect），靠这一点
          // 才不会把缩放中间帧的几何写进进度。
          const scrollTop = scrollerRef.current?.scrollTop;
          if (scrollTop != null) {
            // 维护缩放复位用的滚动快照（含首发初始化到 initialScrollTop）；缩放复位触发的本回调
            // 滞后于 layout effect，故写入的是缩放后稳定值 = 下次缩放的正确基线。
            lastScrollTopRef.current = scrollTop;
            lastScrollLeftRef.current = scrollerRef.current?.scrollLeft ?? 0;
          }
          const page =
            scrollTop != null ? topPageAt(scrollTop, pageH, book.pageCount) : range.startIndex + 1;
          const ratio = scrollTop != null ? intraPageRatio(scrollTop, page, pageH) : 0;
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
          setReadingPercent(pdfPercent(page, book.pageCount));
          if (chId) {
            topChapterIdRef.current = chId;
            if (chId !== currentChapterId) setCurrentChapter(chId);
          }
          if (!sawInitialRange.current) {
            sawInitialRange.current = true;
            return; // 首发非用户滚动，不写进度
          }
          saveAt(page, ratio, pdfPercent(page, book.pageCount));
        }}
        // key 只用 index（默认），不掺 pageW：缩放只改页盒尺寸，canvas 经 PdfPage 的 cssWidth
        // effect 原地重渲到新分辨率（pdf-book 的「同 canvas 约束」由该 effect 的 cancel-then-
        // rerender 满足）。不再整列 remount——避免 Virtuoso 全量重挂后重新落位，把缩放复位的
        // scrollToIndex 冲掉（旧实现三路全跳的共因之一）。
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
  const hoverHighlight = useNoteHoverStore((s) => s.hoverHighlight);
  const leaveHighlight = useNoteHoverStore((s) => s.leaveHighlight);
  const lastNotedId = useRef<string | null>(null);
  const highlights = usePdfHighlights(annos, textLayerRef.current, textReady);
  const [autoLinks, setAutoLinks] = useState<PdfAutoLink[]>([]);

  // 渲染策略：首次/滚动到新页 → 立即渲染；同页缩放（cssWidth 变）→ debounce 重渲，过程中可见
  // canvas 保持旧 bitmap、靠 CSS 拉伸到新页盒尺寸（短暂模糊但不闪、不卡）。重渲走离屏 canvas +
  // 完成后同步 drawImage swap：绕开 `canvas.width=` 赋值清空可见画布造成的空白帧（闪白根因）。
  const renderedWidthRef = useRef<number | null>(null);
  useEffect(() => {
    if (!canvasRef.current) return;
    // stale 守卫：cancel 时 done 也 resolve（pdf-book 契约）——effect 重跑/卸载后旧 task 的 then
    // 绝不能再碰 state 或 swap，否则会在新渲染完成前把 textReady 抢先置 true 且永不纠正。
    let stale = false;
    let task: { done: Promise<void>; cancel: () => void } | null = null;
    const doRender = () => {
      if (stale) return;
      setRenderError(false);
      setTextReady(false);
      const offscreen = document.createElement("canvas");
      task = book.renderPage(
        index,
        offscreen,
        cssWidth,
        textLayerRef.current ?? undefined,
        annotationLayerRef.current ?? undefined,
        onLinkPage,
      );
      task.done
        .then(() => {
          if (stale) return;
          const vis = canvasRef.current;
          if (vis && offscreen.width > 0) {
            // 设尺寸（清空）+ drawImage 在同一同步块内完成 → 浏览器下次 paint 直接见新画面、无空白帧。
            vis.width = offscreen.width;
            vis.height = offscreen.height;
            vis.getContext("2d")?.drawImage(offscreen, 0, 0);
          }
          renderedWidthRef.current = cssWidth;
          setAutoLinks(buildPdfAutoLinks(textLayerRef.current, autoLinkLayerRef.current));
          setTextReady(true);
        })
        .catch(() => {
          if (!stale) setRenderError(true);
        });
    };
    // 已成功渲染过本页 → 缩放重渲走 debounce（过程中拉伸旧画面）；未渲染过 → 立即（开页/翻页不延迟）。
    let timer: ReturnType<typeof setTimeout> | null = null;
    if (renderedWidthRef.current == null) doRender();
    else timer = setTimeout(doRender, RENDER_DEBOUNCE_MS);
    return () => {
      stale = true;
      if (timer) clearTimeout(timer);
      task?.cancel();
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

  // hover 可点击目标（标注高亮 / 活跃选区）→ pointer cursor；命中带笔记高亮 → 弹卡片。
  // overlay pointer-events-none 不接事件，统一在容器 mousemove 命中测试。
  const onMouseMove = (e: ReactMouseEvent) => {
    const layer = textLayerRef.current;
    if (!layer) return;
    const base = layer.getBoundingClientRect();
    const hit =
      highlights.length > 0
        ? hitHighlight(highlights, e.clientX - base.x, e.clientY - base.y)
        : undefined;
    const over = pointInDomSelection(e.clientX, e.clientY) || hit !== undefined;
    if (over) layer.setAttribute("data-pointer", "");
    else layer.removeAttribute("data-pointer");

    const noted = hit?.hasNote ? hit : undefined;
    const id = noted?.annoId ?? null;
    if (id !== lastNotedId.current) {
      lastNotedId.current = id;
      if (noted) {
        hoverHighlight(noted.annoId, {
          x: noted.rect.left + base.x,
          y: noted.rect.top + base.y,
          width: noted.rect.width,
          height: noted.rect.height,
        });
      } else {
        leaveHighlight();
      }
    }
  };
  const onMouseLeave = () => {
    textLayerRef.current?.removeAttribute("data-pointer");
    if (lastNotedId.current !== null) {
      lastNotedId.current = null;
      leaveHighlight();
    }
  };

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
                className={cn("absolute", overlayClass(h.style, h.hasNote))}
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
