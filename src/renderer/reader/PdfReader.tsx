import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Virtuoso } from "react-virtuoso";
import { Minus, Plus } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { cn } from "@renderer/lib/utils";
import { useThemeStore } from "@renderer/store/theme-store";
import { useAnnotationStore } from "@renderer/store/annotation-store";
import { qk } from "../query/keys";
import { createPdfBook, type PdfBook } from "./pdf-book";
import { makePdfLocator, parsePdfLocator } from "./pdf-locator";
import { buildPdfSelectionInfo, flatOffsetOf } from "./pdf-selection";

interface Props {
  bookId: string;
}

const SAVE_DEBOUNCE_MS = 1000; // 对齐 EpubReader
/** 缩放档位：相对适宽的倍率。 */
const ZOOM_STEPS = [0.75, 1, 1.25, 1.5, 2] as const;
/** 页列表左右留白（px）。 */
const PAGE_GUTTER = 48;

export function PdfReader({ bookId }: Props) {
  const { t } = useTranslation();
  const resolvedTheme = useThemeStore((s) => s.resolvedTheme);
  const qc = useQueryClient();
  const [book, setBook] = useState<PdfBook | null>(null);
  const [parseError, setParseError] = useState<string | null>(null);
  const [zoomIdx, setZoomIdx] = useState(1); // 1 = 适宽 100%
  const [containerW, setContainerW] = useState(0);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Virtuoso 挂载即触发一次 rangeChanged（含进度恢复时）——首发不是用户滚动，跳过免得无谓写库。
  const sawInitialRange = useRef(false);

  const setSelection = useAnnotationStore((s) => s.setSelection);

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
        if (alive) setParseError(err instanceof Error ? err.message : String(err));
      });
    return () => {
      alive = false;
      created?.destroy();
      setBook(null);
      // 换书/重解析时丢弃挂起的进度保存，避免把上一本的状态带到下一本。
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, [bytes.data]);

  // 组件卸载时清 timer（补充：bytes.data 未变化但卸载时确保清理）。
  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
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
  const onMouseDown = () => setSelection(null);

  // 滚动即放弃（对齐 EpubReader）：工具栏锚定视口坐标，滚动后位置失真。
  // 捕获阶段监听 document——scroll 不冒泡，但能捕获到 Virtuoso 滚动容器的滚动。
  useEffect(() => {
    const onScroll = () => setSelection(null);
    document.addEventListener("scroll", onScroll, true);
    return () => document.removeEventListener("scroll", onScroll, true);
  }, [setSelection]);

  const saveAt = (page: number) => {
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      const locator = makePdfLocator({ page, scrollRatio: 0 }); // 页级精度（页内比例留打磨期）
      void window.api.progress.save({ bookId, locator });
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
  const pageW = Math.max(200, (containerW - PAGE_GUTTER) * ZOOM_STEPS[zoomIdx]!);
  const pageH = pageW * (book.baseSize.height / book.baseSize.width);

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
        className="no-scrollbar h-full"
        totalCount={book.pageCount}
        defaultItemHeight={pageH + 16}
        increaseViewportBy={{ top: pageH, bottom: pageH }}
        initialTopMostItemIndex={{ index: initialPage, align: "start" }}
        rangeChanged={(range) => {
          if (!sawInitialRange.current) {
            sawInitialRange.current = true;
            return;
          }
          saveAt(range.startIndex + 1);
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
          />
        )}
      />
      <div className="absolute right-4 top-3 z-10 flex items-center gap-1 rounded-md border border-border bg-background/90 px-1.5 py-1 shadow-sm backdrop-blur">
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("reader.pdf.zoomOut", "缩小")}
          disabled={zoomIdx === 0}
          onClick={() => setZoomIdx((i) => Math.max(0, i - 1))}
        >
          <Minus />
        </Button>
        <span className="min-w-12 text-center font-sans text-xs text-muted-foreground">
          {Math.round(ZOOM_STEPS[zoomIdx]! * 100)}%
        </span>
        <Button
          variant="ghost"
          size="icon"
          aria-label={t("reader.pdf.zoomIn", "放大")}
          disabled={zoomIdx === ZOOM_STEPS.length - 1}
          onClick={() => setZoomIdx((i) => Math.min(ZOOM_STEPS.length - 1, i + 1))}
        >
          <Plus />
        </Button>
      </div>
    </div>
  );
}

/** 单页：canvas + textLayer 叠层；卸载/参数变化取消未完成渲染（pdf-book 契约要求）。 */
function PdfPage(props: {
  book: PdfBook;
  index: number;
  cssWidth: number;
  cssHeight: number;
  invert: boolean;
}) {
  const { book, index, cssWidth, cssHeight, invert } = props;
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const textLayerRef = useRef<HTMLDivElement | null>(null);
  const [renderError, setRenderError] = useState(false);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setRenderError(false);
    const task = book.renderPage(index, canvas, cssWidth, textLayerRef.current ?? undefined);
    task.done.catch(() => setRenderError(true)); // done 可能 reject（pdf-book 契约）
    return () => task.cancel();
  }, [book, index, cssWidth]);

  return (
    <div className="flex justify-center py-2">
      {renderError ? (
        <div
          className="flex items-center justify-center bg-muted font-sans text-xs text-muted-foreground"
          // 运行时计算的页面尺寸（规范允许内联承载运行时值）
          style={{ width: cssWidth, height: cssHeight }}
        >
          ⚠ p.{index + 1}
        </div>
      ) : (
        <div className="relative shadow-sm" style={{ width: cssWidth, height: cssHeight }}>
          <canvas
            ref={canvasRef}
            className={cn("h-full w-full", invert && "[filter:invert(1)_hue-rotate(180deg)]")}
          />
          {/* data-page：选区处理据此识别页号（1-based）。invert 滤镜只作用于 canvas，
              textLayer 的 ::selection 高亮在暗色下保持可见。 */}
          <div ref={textLayerRef} data-page={index + 1} className="textLayer" />
        </div>
      )}
    </div>
  );
}
