import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import type { ConversationDto } from "@shared/chat";
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

  const primaryLabel = (c: ConversationDto): string =>
    c.title?.trim() ? c.title : t("reader.conversation.untitled", "未命名会话");
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
            <span className="shrink-0 text-[10px] text-muted-foreground/70">
              {relativeTime(c.updatedAt, now, i18n.language)}
            </span>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}
