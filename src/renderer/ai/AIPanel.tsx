import { useEffect, useMemo, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { Plus, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { useChatStore } from "@renderer/store/chat-store";
import { createIpcChatTransport } from "@renderer/ai/ipc-chat-transport";
import type { ChatUIMessage } from "@renderer/ai/types";
import { MessageList } from "@renderer/ai/MessageList";
import { Composer } from "@renderer/ai/Composer";
import { SummaryPill } from "@renderer/ai/SummaryPill";

export function AIPanel() {
  const { t } = useTranslation();
  const transport = useMemo(() => createIpcChatTransport(), []);
  const { messages, sendMessage, status, stop, setMessages, error } = useChat<ChatUIMessage>({
    transport,
  });
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const setPanelOpen = useChatStore((s) => s.setPanelOpen);
  const scrollRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  const newConversation = () => {
    setMessages([]);
    setActiveConversation(null);
  };

  return (
    <div className="flex h-full flex-col bg-muted/30 font-sans">
      <header className="flex h-11 shrink-0 items-center gap-2 border-b border-border px-3">
        <span className="text-xs font-semibold">{t("ai.panelTitle", "AI 助手")}</span>
        <div className="ms-auto flex items-center gap-1.5">
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
            onClick={() => setPanelOpen(false)}
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

      <Composer
        status={status}
        onStop={stop}
        onSend={(text, chips) => void sendMessage({ text, metadata: { contextChips: chips } })}
      />
    </div>
  );
}
