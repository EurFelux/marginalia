import { useEffect, useMemo, useRef } from "react";
import { useChat } from "@ai-sdk/react";
import { Plus, X } from "lucide-react";
import { useReaderStore } from "@renderer/store/reader-store";
import { createIpcChatTransport } from "@renderer/ai/ipc-chat-transport";
import type { ChatUIMessage } from "@renderer/ai/types";
import { MessageList } from "@renderer/ai/MessageList";
import { Composer } from "@renderer/ai/Composer";
import { SummaryPill } from "@renderer/ai/SummaryPill";

export function AIPanel() {
  const transport = useMemo(() => createIpcChatTransport(), []);
  const { messages, sendMessage, status, stop, setMessages, error } = useChat<ChatUIMessage>({
    transport,
  });
  const setActiveConversation = useReaderStore((s) => s.setActiveConversation);
  const setPanelOpen = useReaderStore((s) => s.setPanelOpen);
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
        <span className="text-xs font-semibold">AI 助手</span>
        <div className="ml-auto flex items-center gap-1.5">
          <SummaryPill />
          <button
            onClick={newConversation}
            aria-label="新对话"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
          >
            <Plus className="size-4" />
          </button>
          <button
            onClick={() => setPanelOpen(false)}
            aria-label="关闭面板"
            className="rounded-md p-1.5 text-muted-foreground hover:bg-muted"
          >
            <X className="size-4" />
          </button>
        </div>
      </header>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-4">
        <MessageList messages={messages} status={status} />
      </div>

      {error && (
        <div className="shrink-0 border-t border-border bg-destructive/10 px-3 py-2 text-xs text-destructive">
          发送失败：{error.message}
          <span className="text-muted-foreground">
            （请确认已在「设置」配置 Anthropic API Key 与模型）
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
