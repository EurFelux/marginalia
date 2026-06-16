// src/renderer/ai/FloatingAssistant.tsx —— 书库/统计视图的全局悬浮助手（spec 2026-06-16 §5.4）。
import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@renderer/components/ui/button";
import { AIPanel } from "@renderer/ai/AIPanel";
import { useRestoreConversation } from "@renderer/ai/use-restore-conversation";
import { usePrefsStore } from "@renderer/store/prefs-store";
import type { ChatContext } from "@renderer/ai/chat-context";

const LIBRARY_CONTEXT: ChatContext = { kind: "library" };

export function FloatingAssistant() {
  const { t } = useTranslation();
  const agentName = usePrefsStore((s) => s.soul.name);
  const [open, setOpen] = useState(false);
  // 进入书库/统计（AppShell 挂载）时恢复上次的 library 会话；book→library 会 remount → 重新恢复。
  // 开关浮窗本身不 remount 故不重跑，靠 AIPanel 挂载消费仍在的 openCommand（见 chat-store openCommand）。
  useRestoreConversation(LIBRARY_CONTEXT);

  if (!open) {
    return (
      <Button
        size="icon"
        onClick={() => setOpen(true)}
        aria-label={t("ai.openLibraryAssistant", "问问 {{name}}", { name: agentName })}
        className="fixed bottom-6 end-6 z-40 size-12 rounded-full shadow-lg"
      >
        <MessageCircle />
      </Button>
    );
  }

  return (
    <div className="fixed bottom-6 end-6 z-40 flex h-[600px] max-h-[80vh] w-96 flex-col overflow-hidden rounded-xl border border-border bg-background shadow-2xl">
      <AIPanel context={LIBRARY_CONTEXT} onClose={() => setOpen(false)} />
    </div>
  );
}
