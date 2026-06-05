import { useEffect, useMemo, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { useChatStore } from "@renderer/store/chat-store";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { useChapterTitle } from "@renderer/query/use-chapter-title";
import { createIpcChatTransport } from "@renderer/ai/ipc-chat-transport";
import type { ChatUIMessage } from "@renderer/ai/types";
import { MessageList } from "@renderer/ai/MessageList";
import { Composer } from "@renderer/ai/Composer";
import { SummaryPill } from "@renderer/ai/SummaryPill";
import { messagesToUI } from "@renderer/ai/message-history";
import type { Chip } from "@shared/chat";

export function AIPanel() {
  const { t } = useTranslation();
  const transport = useMemo(() => createIpcChatTransport(), []);
  const { messages, sendMessage, status, stop, setMessages, error } = useChat<ChatUIMessage>({
    transport,
  });
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const updateLayout = usePrefsStore((s) => s.updateLayout);
  const openCommand = useChatStore((s) => s.openCommand);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const activeConversationChapterId = useChatStore((s) => s.activeConversationChapterId);
  const currentChapterId = useNavigationStore((s) => s.currentChapterId);
  // header 第二行章节名（移植 UP1 AIPanel）：优先会话归属章（与面板内消息一致），
  // 无活跃会话回退当前阅读章（新会话将归属它）。title 缺失则整行隐藏。
  const chapterTitle = useChapterTitle(activeConversationChapterId ?? currentChapterId);
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
      .catch((err: unknown) => console.warn("[ai] load conversation history failed:", err));
    return () => {
      cancelled = true;
    };
  }, [openCommand, stop, setMessages]);

  // 一轮发送结束（曾 streaming/submitted → 回 ready/error）→ 刷新会话列表（新会话 / 标题 / updatedAt）。
  // 用前缀 ["conversations"] 失效（不需 bookId），匹配 qk.conversations(bookId)=["conversations",bookId]。
  useEffect(() => {
    if (prevStatus.current !== "ready" && (status === "ready" || status === "error")) {
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    }
    prevStatus.current = status;
  }, [status, qc]);

  // active 置空（划词跨章进入无 active / 新对话 / 开书）→ 清面板；初始即空时为 no-op。
  useEffect(() => {
    if (activeConversationId === null) setMessages([]);
  }, [activeConversationId, setMessages]);

  const newConversation = () => {
    setMessages([]);
    setActiveConversation(null);
  };

  const handleSend = (text: string, chips: Chip[]) => {
    void sendMessage({ text, metadata: { contextChips: chips } });
  };

  return (
    <div className="flex h-full flex-col bg-muted/30 font-sans">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <div className="flex min-w-0 flex-col">
          <span className="truncate text-xs font-semibold">{t("ai.panelTitle", "AI 助手")}</span>
          {chapterTitle && (
            <span className="truncate text-[11px] text-muted-foreground">
              {t("ai.conversationSuffix", "{{title}} · 会话", { title: chapterTitle })}
            </span>
          )}
        </div>
        <div className="ms-auto flex shrink-0 items-center gap-1.5">
          <SummaryPill />
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={newConversation}
            aria-label={t("ai.newConversation", "新对话")}
            className="text-muted-foreground"
          >
            <Plus />
          </Button>
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={() => updateLayout({ panelOpen: false })}
            aria-label={t("ai.closePanel", "关闭面板")}
            className="text-muted-foreground"
          >
            <X />
          </Button>
        </div>
      </header>

      <ScrollArea className="min-h-0 flex-1" viewportRef={scrollRef}>
        <div className="p-4">
          <MessageList messages={messages} status={status} />
        </div>
      </ScrollArea>

      {error && (
        <div className="shrink-0 border-t border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          {t("ai.sendFailed", "发送失败：{{message}}", { message: error.message })}
          <span className="text-muted-foreground">
            {t("ai.sendFailedHint", "（请确认已在「设置」配置 Anthropic API Key 与模型）")}
          </span>
        </div>
      )}

      <Composer status={status} onStop={stop} onSend={handleSend} />
    </div>
  );
}
