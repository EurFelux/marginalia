import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createLogger } from "@renderer/logger";

const log = createLogger("reader");
import {
  ArrowLeft,
  PanelLeftClose,
  PanelLeftOpen,
  PanelRightClose,
  PanelRightOpen,
  PanelTopClose,
  PanelTopOpen,
  Settings,
} from "lucide-react";
import { qk } from "@renderer/query/keys";
import { Button } from "@renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { useSettingsStore } from "@renderer/store/settings-store";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { CollapsiblePane } from "@renderer/reader/CollapsiblePane";
import { Sidebar } from "@renderer/reader/Sidebar";
import { EpubReader } from "@renderer/reader/EpubReader";
import { PdfReader } from "@renderer/reader/PdfReader";
import { ReaderPrefs } from "@renderer/reader/ReaderPrefs";
import { PdfPrefs } from "@renderer/reader/PdfPrefs";
import { SelectionToolbar } from "@renderer/reader/SelectionToolbar";
import { HighlightStyleBar } from "@renderer/reader/HighlightStyleBar";
import { NoteModal } from "@renderer/reader/NoteModal";
import { NoteHoverCard } from "@renderer/reader/NoteHoverCard";
import { AIPanel } from "@renderer/ai/AIPanel";
import { SummaryPill } from "@renderer/ai/SummaryPill";
import { useRestoreConversation } from "@renderer/ai/use-restore-conversation";
import { openPanelAndFocusComposer } from "@renderer/ai/composer-focus";

export function ReaderView() {
  const { t } = useTranslation();
  const bookId = useNavigationStore((s) => s.currentBookId);
  useRestoreConversation(bookId);
  const chapterId = useNavigationStore((s) => s.currentChapterId);
  const backToLibrary = useNavigationStore((s) => s.backToLibrary);
  const readingPercent = useNavigationStore((s) => s.readingPercent);
  const readingContext = useNavigationStore((s) => s.readingContext);
  const openSettings = useSettingsStore((s) => s.setOpen);
  const autoSummarize = usePrefsStore((s) => s.autoSummarize);
  const layout = usePrefsStore((s) => s.layout);
  const updateLayout = usePrefsStore((s) => s.updateLayout);
  const qc = useQueryClient();

  const chapters = useQuery({
    queryKey: qk.chapters(bookId ?? ""),
    queryFn: () => window.api.content.chapters({ bookId: bookId! }),
    enabled: bookId != null,
  });

  // 顶栏面包屑用书名：与 BookCard 同 key（qk.book），React Query 去重，零额外 IPC。
  const book = useQuery({
    queryKey: qk.book(bookId ?? ""),
    queryFn: () => window.api.library.get({ bookId: bookId! }),
    enabled: bookId != null,
  });

  // 开章自动生成摘要（设置开启时）：停在某章 ~800ms 才触发，避免快速翻阅时为每章都生成。
  // 注：当前章 id 现由 EpubReader 据滚动位置回写（onTopSectionChange），不再在此回填首章——
  // 否则开书时强设首章会覆盖 EpubReader 的 CFI 进度恢复（initialIndex）。
  // 主进程 ensureChapterSummary 仅从 pending 起，故对已就绪章重复触发是廉价 no-op。
  useEffect(() => {
    if (!autoSummarize || bookId == null || chapterId == null) return;
    if (book.data?.hasTextLayer === false) return;
    const t = setTimeout(() => {
      void window.api.content
        .generateChapterSummary({ bookId, chapterId })
        .then(() => qc.invalidateQueries({ queryKey: qk.chapterSummary(bookId, chapterId) }))
        .catch((err: unknown) => log.warn("auto chapter summary failed", err));
    }, 800);
    return () => clearTimeout(t);
  }, [autoSummarize, bookId, chapterId, qc, book.data?.hasTextLayer]);

  if (!bookId) return null;

  const sidebarLabel = layout.sidebarOpen
    ? t("reader.collapseSidebar", "收起侧栏")
    : t("reader.expandSidebar", "展开侧栏");
  const panelLabel = layout.panelOpen
    ? t("reader.collapseAiPanel", "收起 AI 面板")
    : t("reader.expandAiPanel", "展开 AI 面板");
  const headerLabel = layout.headerOpen
    ? t("reader.collapseHeader", "收起顶栏")
    : t("reader.expandHeader", "展开顶栏");

  // 顶栏面包屑「书名 · 章节名 · 进度」：任一缺失只显示有的部分。进度：epub 纯百分比；
  // PDF 带页码（page/pageCount 从 readingContext 读——pdf 分支已有，percent 走独立 store 字段）。
  const chapterTitle = chapters.data?.find((c) => c.id === chapterId)?.title ?? null;
  const progressLabel = (() => {
    if (readingPercent == null) return null;
    const pct = `${Math.round(readingPercent * 100)}%`;
    return readingContext?.format === "pdf" && readingContext.pageCount != null
      ? `${readingContext.page} / ${readingContext.pageCount} · ${pct}`
      : pct;
  })();
  const breadcrumb = [book.data?.title, chapterTitle, progressLabel].filter(Boolean).join(" · ");

  return (
    <div className="relative flex h-screen flex-col bg-background font-sans text-foreground">
      <CollapsiblePane
        side="top"
        open={layout.headerOpen}
        sizeClass="h-12"
        label={t("reader.expandHeader", "展开顶栏")}
      >
        <header className="flex h-full items-center justify-between px-3">
          <div className="flex min-w-0 items-center gap-1">
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => updateLayout({ sidebarOpen: !layout.sidebarOpen })}
                    aria-label={sidebarLabel}
                    className="text-muted-foreground"
                  />
                }
              >
                {layout.sidebarOpen ? <PanelLeftClose /> : <PanelLeftOpen />}
              </TooltipTrigger>
              <TooltipContent>{sidebarLabel}</TooltipContent>
            </Tooltip>
            <Button
              variant="ghost"
              size="sm"
              onClick={backToLibrary}
              className="text-muted-foreground"
            >
              <ArrowLeft />
              {t("reader.backToLibrary", "书库")}
            </Button>
            {breadcrumb && (
              <div className="ms-2 hidden min-w-0 items-center gap-2 text-xs text-muted-foreground sm:flex">
                <span className="size-1 shrink-0 rounded-full bg-border" />
                <span className="truncate">{breadcrumb}</span>
              </div>
            )}
            {/* !isPending：book 未就绪时不渲染，避免扫描版开书的「先现后隐」布局抖动 */}
            {!book.isPending && book.data?.hasTextLayer !== false && (
              <div className="hidden shrink-0 sm:block">
                <SummaryPill />
              </div>
            )}
          </div>
          <div className="flex shrink-0 items-center gap-1">
            {!book.isPending && (book.data?.format === "pdf" ? <PdfPrefs /> : <ReaderPrefs />)}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() =>
                      layout.panelOpen
                        ? updateLayout({ panelOpen: false })
                        : openPanelAndFocusComposer()
                    }
                    aria-label={panelLabel}
                    className="text-muted-foreground"
                  />
                }
              >
                {layout.panelOpen ? <PanelRightClose /> : <PanelRightOpen />}
              </TooltipTrigger>
              <TooltipContent>{panelLabel}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => openSettings(true)}
                    aria-label={t("settings.title", "设置")}
                    className="text-muted-foreground"
                  />
                }
              >
                <Settings />
              </TooltipTrigger>
              <TooltipContent>{t("settings.title", "设置")}</TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    variant="ghost"
                    size="icon"
                    onClick={() => updateLayout({ headerOpen: !layout.headerOpen })}
                    aria-label={headerLabel}
                    className="text-muted-foreground"
                  />
                }
              >
                {layout.headerOpen ? <PanelTopClose /> : <PanelTopOpen />}
              </TooltipTrigger>
              <TooltipContent>{headerLabel}</TooltipContent>
            </Tooltip>
          </div>
        </header>
      </CollapsiblePane>
      {/* overflow-hidden：收起抽屉以 translate 藏出容器边缘，不裁剪会撑出横向滚动。 */}
      <div className="relative flex min-h-0 flex-1 overflow-hidden">
        <CollapsiblePane
          side="left"
          open={layout.sidebarOpen}
          sizeClass="w-64"
          label={t("reader.expandSidebar", "展开侧栏")}
        >
          <Sidebar bookId={bookId} />
        </CollapsiblePane>
        <main className="min-w-0 flex-1">
          {/* 按格式分发：book 查询就绪前不渲染（避免 PDF 书闪挂 EpubReader）。
              EpubReader 自管载入/错误态，并据 CFI 进度恢复初始位置。 */}
          {book.isPending ? null : book.data?.format === "pdf" ? (
            <PdfReader bookId={bookId} chapters={chapters.data ?? []} />
          ) : (
            <EpubReader bookId={bookId} chapters={chapters.data ?? []} />
          )}
        </main>
        <CollapsiblePane
          side="right"
          open={layout.panelOpen}
          sizeClass="w-96"
          label={t("reader.expandAiPanel", "展开 AI 面板")}
        >
          <AIPanel />
        </CollapsiblePane>
      </div>
      <SelectionToolbar />
      <HighlightStyleBar />
      <NoteModal />
      <NoteHoverCard />
    </div>
  );
}
