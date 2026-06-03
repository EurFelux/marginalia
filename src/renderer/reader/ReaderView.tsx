import { useEffect } from "react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, MessageSquare, Settings } from "lucide-react";
import { qk } from "@renderer/query/keys";
import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@renderer/components/ui/tooltip";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { useChatStore } from "@renderer/store/chat-store";
import { useSettingsStore } from "@renderer/store/settings-store";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { Sidebar } from "@renderer/reader/Sidebar";
import { EpubReader } from "@renderer/reader/EpubReader";
import { ReaderPrefs } from "@renderer/reader/ReaderPrefs";
import { SelectionToolbar } from "@renderer/reader/SelectionToolbar";
import { HighlightStyleBar } from "@renderer/reader/HighlightStyleBar";
import { NoteModal } from "@renderer/reader/NoteModal";
import { AIPanel } from "@renderer/ai/AIPanel";

export function ReaderView() {
  const { t } = useTranslation();
  const bookId = useNavigationStore((s) => s.currentBookId);
  const chapterId = useNavigationStore((s) => s.currentChapterId);
  const backToLibrary = useNavigationStore((s) => s.backToLibrary);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const setPanelOpen = useChatStore((s) => s.setPanelOpen);
  const openSettings = useSettingsStore((s) => s.setOpen);
  const autoSummarize = usePrefsStore((s) => s.autoSummarize);
  const qc = useQueryClient();

  const chapters = useQuery({
    queryKey: qk.chapters(bookId ?? ""),
    queryFn: () => window.api.content.chapters({ bookId: bookId! }),
    enabled: bookId != null,
  });

  // 开章自动生成摘要（设置开启时）：停在某章 ~800ms 才触发，避免快速翻阅时为每章都生成。
  // 注：当前章 id 现由 EpubReader 据滚动位置回写（onTopIndexChange），不再在此回填首章——
  // 否则开书时强设首章会覆盖 EpubReader 的 CFI 进度恢复（initialIndex）。
  // 主进程 ensureChapterSummary 仅从 pending 起，故对已就绪章重复触发是廉价 no-op。
  useEffect(() => {
    if (!autoSummarize || bookId == null || chapterId == null) return;
    const t = setTimeout(() => {
      void window.api.content
        .generateChapterSummary({ bookId, chapterId })
        .then(() => qc.invalidateQueries({ queryKey: qk.chapterSummary(bookId, chapterId) }))
        .catch(() => {});
    }, 800);
    return () => clearTimeout(t);
  }, [autoSummarize, bookId, chapterId, qc]);

  if (!bookId) return null;

  return (
    <div className="flex h-screen flex-col bg-background font-sans text-foreground">
      <header className="flex h-12 shrink-0 items-center justify-between border-b border-border px-3">
        <Button variant="ghost" size="sm" onClick={backToLibrary} className="text-muted-foreground">
          <ArrowLeft />
          {t("reader.backToLibrary", "书库")}
        </Button>
        <div className="flex items-center gap-1">
          <ReaderPrefs />
          <Tooltip>
            <TooltipTrigger
              render={
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={() => setPanelOpen(!panelOpen)}
                  aria-label={t("reader.aiPanel", "AI 面板")}
                  className={cn(panelOpen ? "text-primary" : "text-muted-foreground")}
                />
              }
            >
              <MessageSquare />
            </TooltipTrigger>
            <TooltipContent>{t("reader.aiPanel", "AI 面板")}</TooltipContent>
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
        </div>
      </header>
      <div className="flex min-h-0 flex-1">
        <aside className="w-64 shrink-0 border-e border-border bg-muted/30">
          <Sidebar bookId={bookId} />
        </aside>
        <main className="min-w-0 flex-1">
          {/* 无条件渲染：EpubReader 自管载入/错误态，并据 CFI 进度恢复初始位置（不门控在 chapterId 上，
              否则需先有当前章才渲染，与「开书即按进度连续渲染」相悖）。 */}
          <EpubReader bookId={bookId} chapters={chapters.data ?? []} />
        </main>
        {/* 始终挂载，用 hidden 切换可见——保住 useChat 对话状态在开合间存活。 */}
        <aside className={cn("w-96 shrink-0 border-s border-border", !panelOpen && "hidden")}>
          <AIPanel />
        </aside>
      </div>
      <SelectionToolbar />
      <HighlightStyleBar />
      <NoteModal />
    </div>
  );
}
