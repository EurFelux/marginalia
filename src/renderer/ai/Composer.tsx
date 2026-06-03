import { useEffect, useRef, type KeyboardEvent } from "react";
import type { ChatStatus } from "ai";
import { ArrowUp, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Chip } from "@shared/chat";
import { Button } from "@renderer/components/ui/button";
import { useChatStore } from "@renderer/store/chat-store";
import { ChipBar } from "@renderer/ai/ChipBar";

interface Props {
  status: ChatStatus;
  onSend: (text: string, chips: Chip[]) => void;
  onStop: () => void;
}

export function Composer({ status, onSend, onStop }: Props) {
  const { t } = useTranslation();
  const draftText = useChatStore((s) => s.draftText);
  const draftChips = useChatStore((s) => s.draftChips);
  const setDraftText = useChatStore((s) => s.setDraftText);
  const setDraftChips = useChatStore((s) => s.setDraftChips);
  const panelOpen = useChatStore((s) => s.panelOpen);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    if (panelOpen) ref.current?.focus({ preventScroll: true });
  }, [panelOpen]);

  const send = () => {
    const text = draftText.trim();
    if (!text || isStreaming) return;
    onSend(text, draftChips);
    setDraftText("");
    setDraftChips([]);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="shrink-0 border-t border-border bg-card/40 p-3">
      {draftChips.length > 0 && (
        <div className="mb-2">
          <ChipBar chips={draftChips} />
        </div>
      )}
      <div className="flex items-end gap-2 rounded-xl border border-border bg-background p-2 focus-within:ring-1 focus-within:ring-ring">
        <textarea
          ref={ref}
          value={draftText}
          onChange={(e) => setDraftText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={2}
          placeholder={t("ai.composer.placeholder", "问点什么…（Enter 发送，Shift+Enter 换行）")}
          className="max-h-32 min-h-9 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground"
        />
        {isStreaming ? (
          <Button
            variant="secondary"
            size="icon-lg"
            onClick={onStop}
            aria-label={t("ai.stop", "停止")}
          >
            <Square />
          </Button>
        ) : (
          <Button
            size="icon-lg"
            onClick={send}
            disabled={draftText.trim() === ""}
            aria-label={t("ai.send", "发送")}
          >
            <ArrowUp />
          </Button>
        )}
      </div>
    </div>
  );
}
