import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { MessagesSquare, Trash2 } from "lucide-react";
import { toast } from "sonner";
import type { ConversationDto } from "@shared/chat";
import { cn } from "@renderer/lib/utils";
import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuTrigger,
} from "@renderer/components/ui/context-menu";
import { useChatStore } from "@renderer/store/chat-store";
import { relativeTime } from "@renderer/lib/relative-time";
import { conversationsQuery } from "@renderer/query/conversation-queries";
import { qk } from "@renderer/query/keys";

export function ConversationsTab({ bookId }: { bookId: string }) {
  const { t, i18n } = useTranslation();
  const qc = useQueryClient();
  const activeId = useChatStore((s) => s.activeConversationId);
  const openConversation = useChatStore((s) => s.openConversation);
  const convos = useQuery(conversationsQuery(bookId));
  const [confirmTarget, setConfirmTarget] = useState<ConversationDto | null>(null);

  // 删会话：abort 在跑流 + 级联删消息由主进程负责；成功后先清 active 再失效列表 + toast。
  const deleteConvo = useMutation({
    mutationFn: (c: ConversationDto) => window.api.chat.conversations.delete({ id: c.id }),
    onSuccess: (_r, c) => {
      // 先清 active（防 dangling 窗口内向已删会话发送），再失效列表。
      // 回落 = 新会话空状态（spec DD-3）：AIPanel 既有 effect 清面板，chips 预亮镜像「开书无会话」。
      const s = useChatStore.getState();
      if (s.activeConversationId === c.id) {
        s.setActiveConversation(null);
        s.setSummaryChipsPreset();
      }
      // 该会话的消息缓存整体移除（remove 非 invalidate——实体已没，不该 refetch；镜像 deleteBook）。
      qc.removeQueries({ queryKey: qk.messages(c.id) });
      void qc.invalidateQueries({ queryKey: qk.conversations(bookId) });
      toast.success(t("reader.conversation.deleted", "已删除会话"));
    },
    onError: (e) => {
      // 透传主进程真实错误（honest-error），不自动消失。
      toast.error(
        t("reader.conversation.deleteFailed", "删除失败：{{error}}", {
          error: (e as Error).message,
        }),
        { closeButton: true, duration: Infinity },
      );
    },
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
    <>
      <ScrollArea className="h-full">
        <div className="space-y-1 p-2">
          {list.map((c) => (
            <ConversationRow
              key={c.id}
              convo={c}
              active={c.id === activeId}
              label={primaryLabel(c)}
              time={relativeTime(c.updatedAt, now, i18n.language)}
              onOpen={() => openConversation(c.id)}
              onDeleteRequest={() => setConfirmTarget(c)}
            />
          ))}
        </div>
      </ScrollArea>

      <AlertDialog
        open={confirmTarget !== null}
        onOpenChange={(open) => {
          if (!open) setConfirmTarget(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>
            {t("reader.conversation.deleteConfirm.title", "删除会话「{{title}}」？", {
              title: confirmTarget ? primaryLabel(confirmTarget) : "",
            })}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "reader.conversation.deleteConfirm.body",
              "将永久删除该会话及其全部消息。此操作不可撤销。",
            )}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirmTarget(null)}>
              {t("reader.conversation.deleteConfirm.cancel", "取消")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmTarget) deleteConvo.mutate(confirmTarget);
                setConfirmTarget(null);
              }}
            >
              {t("reader.conversation.deleteConfirm.confirm", "删除")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

/** 单条会话行：行按钮 + hover 垃圾桶（绝对定位兄弟，不嵌套 button）+ 右键菜单，两条删除路径汇入同一确认。 */
function ConversationRow({
  convo,
  active,
  label,
  time,
  onOpen,
  onDeleteRequest,
}: {
  convo: ConversationDto;
  active: boolean;
  label: string;
  time: string;
  onOpen: () => void;
  onDeleteRequest: () => void;
}) {
  const { t } = useTranslation();
  return (
    <ContextMenu>
      <ContextMenuTrigger render={<div className="group relative" />}>
        <button
          type="button"
          onClick={onOpen}
          className={cn(
            "flex w-full items-center gap-2 rounded-lg border border-transparent p-2 text-start",
            active ? "bg-accent" : "hover:bg-muted",
          )}
        >
          <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
          <span
            className={cn(
              "min-w-0 flex-1 truncate text-xs",
              convo.isNaming ? "animate-pulse text-muted-foreground" : "text-foreground",
            )}
          >
            {label}
          </span>
          {/* 保留布局占位（opacity 而非 hidden）防 hover 时行宽跳动 */}
          <span className="shrink-0 text-[10px] text-muted-foreground/70 group-hover:opacity-0">
            {time}
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDeleteRequest}
          aria-label={t("reader.conversation.deleteAction", "删除会话")}
          className="absolute end-1 top-1/2 hidden -translate-y-1/2 text-muted-foreground hover:text-destructive group-hover:flex"
        >
          <Trash2 />
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem variant="destructive" onClick={onDeleteRequest}>
          {t("reader.conversation.menu.delete", "删除")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}
