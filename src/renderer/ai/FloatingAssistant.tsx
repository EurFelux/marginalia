// src/renderer/ai/FloatingAssistant.tsx —— 书库/统计视图的全局悬浮助手（spec 2026-06-16 §5.4）。
import { useState } from "react";
import { MessageCircle } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "@renderer/components/ui/button";
import { AIPanel } from "@renderer/ai/AIPanel";
import type { ChatContext } from "@renderer/ai/chat-context";

const LIBRARY_CONTEXT: ChatContext = { kind: "library" };

export function FloatingAssistant() {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);

  if (!open) {
    return (
      <Button
        size="icon"
        onClick={() => setOpen(true)}
        aria-label={t("ai.openLibraryAssistant", "问问 Lia")}
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
