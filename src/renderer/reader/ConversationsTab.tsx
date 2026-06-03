import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import type { ConversationDto } from "@shared/chat";
import type { ChapterRefDto } from "@shared/library";
import { cn } from "@renderer/lib/utils";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { qk } from "@renderer/query/keys";
import { useChatStore } from "@renderer/store/chat-store";
import { relativeTime } from "@renderer/lib/relative-time";

export function ConversationsTab({ bookId }: { bookId: string }) {
  const { t, i18n } = useTranslation();
  const activeId = useChatStore((s) => s.activeConversationId);
  const openConversation = useChatStore((s) => s.openConversation);
  const convos = useQuery({
    queryKey: qk.conversations(bookId),
    queryFn: () => window.api.chat.conversations.listByBook({ bookId }),
  });
  const chapters = useQuery({
    queryKey: qk.chapters(bookId),
    queryFn: () => window.api.content.chapters({ bookId }),
  });

  if (convos.isPending)
    return (
      <p className="p-3 text-sm text-muted-foreground">
        {t("reader.conversation.loading", "加载会话…")}
      </p>
    );
  if (convos.isError)
    return (
      <p className="p-3 text-sm text-destructive">
        {t("reader.conversation.loadError", "会话加载失败")}
      </p>
    );
  const list = convos.data ?? [];
  if (list.length === 0)
    return (
      <p className="p-4 text-center text-xs text-muted-foreground">
        {t("reader.conversation.empty", "还没有会话。选段问 AI 试试～")}
      </p>
    );

  const chapterLabel = (c: ConversationDto): string => {
    if (c.kind === "independent") return t("reader.conversation.independent", "独立会话");
    const ch = (chapters.data ?? []).find((x: ChapterRefDto) => x.id === c.chapterId);
    return ch?.title ?? t("reader.conversation.independent", "独立会话");
  };
  // 主标签：title 优先；title 空时退章节标题（章节会话）/未命名（独立会话）。
  const primaryLabel = (c: ConversationDto): string =>
    c.title?.trim()
      ? c.title
      : c.kind === "chapter"
        ? chapterLabel(c)
        : t("reader.conversation.untitled", "未命名会话");
  const now = Date.now();

  return (
    <ScrollArea className="h-full">
      <div className="space-y-1 p-2">
        {list.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => openConversation(c.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg border border-transparent p-2 text-start",
              c.id === activeId ? "bg-accent" : "hover:bg-muted",
            )}
          >
            <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
              {primaryLabel(c)}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground/70">{chapterLabel(c)}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground/70">
              {relativeTime(c.updatedAt, now, i18n.language)}
            </span>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}
