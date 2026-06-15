import { useEffect, useRef } from "react";
import { flushSync } from "react-dom";
import { useChat } from "@ai-sdk/react";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { useChatStore, useActiveConversationId } from "@renderer/store/chat-store";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { createIpcChatTransport } from "@renderer/ai/ipc-chat-transport";
import type { ChatUIMessage } from "@renderer/ai/types";
import { MessageList } from "@renderer/ai/MessageList";
import { Composer } from "@renderer/ai/Composer";
import { messagesToUI } from "@renderer/ai/message-history";
import { conversationsQuery } from "@renderer/query/conversation-queries";
import type { Chip } from "@shared/chat";
import { openPanelAndFocusComposer } from "@renderer/ai/composer-focus";
import { ChatActionsContext, nextAssistantId, type ChatActions } from "@renderer/ai/chat-actions";
import { createLogger } from "@renderer/logger";
import { type ChatContext } from "@renderer/ai/chat-context";

const log = createLogger("ai");

export function AIPanel({ context, onClose }: { context: ChatContext; onClose: () => void }) {
  const { t } = useTranslation();
  const { messages, sendMessage, status, stop, setMessages, regenerate, error } =
    useChat<ChatUIMessage>({
      transport: createIpcChatTransport(context),
      // 流式错误此前只塞进 error 字段弹 banner、从不落日志；补一条 warn 使渲染侧失败也有痕迹可查。
      onError: (err) => log.warn("chat stream error", err),
    });
  const agentName = usePrefsStore((s) => s.soul.name);
  const openCommand = useChatStore((s) => s.openCommand);
  const activeConversationId = useActiveConversationId(context);
  const bookId = context.kind === "book" ? context.bookId : null;
  const convosQuery = useQuery(conversationsQuery(context));
  const activeTitle = activeConversationId
    ? convosQuery.data?.find((c) => c.id === activeConversationId)?.title?.trim() ||
      t("reader.conversation.untitled", "未命名会话")
    : null;
  const qc = useQueryClient();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevStatus = useRef(status);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // 重开会话：openCommand.nonce 变 → 先中止在跑的流（避免增量灌入将被替换的历史、streamId 串台）→ 载历史 → setMessages。
  // 只认 openCommand（一次性命令信号），不认 activeConversationId——后者也被发消息 ack 写入，监听它会在发完消息后误重载。
  useEffect(() => {
    if (!openCommand) return;
    const { conversationId } = openCommand;
    let cancelled = false;
    void stop();
    void window.api.chat.messages
      .listByConversation({ conversationId })
      .then((dtos) => {
        if (!cancelled) setMessages(messagesToUI(dtos));
      })
      .catch((err: unknown) => log.warn("load conversation history failed", err));
    return () => {
      cancelled = true;
    };
  }, [openCommand, stop, setMessages]);

  // 一轮发送结束（曾 streaming/submitted → 回 ready/error）→ 刷新会话列表（新会话 / 标题 / updatedAt）。
  // 同时从 DB 重载消息以同步 UI message ids 到持久化 ids（resend 截断后 id 会变）。
  // 用前缀 ["conversations"] 失效（不需 bookId），匹配 qk.conversations(bookId)=["conversations",bookId]。
  useEffect(() => {
    if (prevStatus.current !== "ready" && (status === "ready" || status === "error")) {
      void qc.invalidateQueries({ queryKey: ["conversations"] });
      if (activeConversationId) {
        void window.api.chat.messages
          .listByConversation({ conversationId: activeConversationId })
          .then((dtos) => setMessages(messagesToUI(dtos)))
          .catch((err: unknown) => log.warn("reload conversation after turn failed", err));
      }
    }
    prevStatus.current = status;
  }, [status, qc, activeConversationId, setMessages]);

  // active 置空（开书无会话 / 切书）→ 清面板；初始即空时为 no-op。
  useEffect(() => {
    if (activeConversationId === null) setMessages([]);
  }, [activeConversationId, setMessages]);

  const newConversation = async () => {
    try {
      // 显式创建空会话（spec §2/§7）；防堆积由主进程兜底（复用既有空会话）
      const convo = await window.api.chat.conversations.create({
        bookId: context.kind === "book" ? context.bookId : null,
      });
      setMessages([]);
      useChatStore.getState().setActiveConversation(context, convo.id);
      useChatStore.getState().setSummaryChipsPreset();
      openPanelAndFocusComposer();
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    } catch (err) {
      log.warn("create conversation failed", err);
    }
  };

  const actions: ChatActions = {
    regenerate: (a) => void regenerate({ messageId: a.id }),
    resend: (u) => {
      const aId = nextAssistantId(messages, u.id);
      void regenerate(aId ? { messageId: aId } : undefined);
    },
    editAndResend: (u, newText) => {
      flushSync(() =>
        setMessages((ms) =>
          ms.map((m) => (m.id === u.id ? { ...m, parts: [{ type: "text", text: newText }] } : m)),
        ),
      );
      const aId = nextAssistantId(messages, u.id);
      void regenerate(aId ? { messageId: aId } : undefined);
    },
    busy: status === "streaming" || status === "submitted",
  };

  const handleSend = (text: string, chips: Chip[]) => {
    void sendMessage({ text, metadata: { contextChips: chips } });
  };

  return (
    <div className="flex h-full flex-col bg-muted/30 font-sans">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-semibold">
            {t("ai.panelTitle", "{{name}}", { name: agentName })}
          </span>
          {activeTitle && (
            <span className="truncate text-[11px] text-muted-foreground">{activeTitle}</span>
          )}
        </div>
        <div className="ms-auto flex shrink-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => void newConversation()}
            aria-label={t("ai.newConversation", "新对话")}
            className="text-muted-foreground"
          >
            <Plus />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={onClose}
            aria-label={t("ai.closePanel", "关闭面板")}
            className="text-muted-foreground"
          >
            <X />
          </Button>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1" viewportRef={scrollRef}>
        <div className="p-4">
          <ChatActionsContext.Provider value={actions}>
            <MessageList messages={messages} status={status} bookId={bookId} />
          </ChatActionsContext.Provider>
        </div>
      </ScrollArea>

      {error && (
        <div className="shrink-0 border-t border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {t("ai.sendFailed", "发送失败：{{message}}", { message: error.message })}
          <span className="text-muted-foreground">
            {t("ai.sendFailedHint", "（请确认已在「设置」配置 API Key 与模型）")}
          </span>
        </div>
      )}

      <Composer status={status} onStop={stop} onSend={handleSend} context={context} />
    </div>
  );
}
