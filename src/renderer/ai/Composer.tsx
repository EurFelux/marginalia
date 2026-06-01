import { useEffect, useRef, type KeyboardEvent } from "react";
import type { ChatStatus } from "ai";
import { ArrowUp, Square } from "lucide-react";
import type { Chip } from "@shared/chat";
import { useReaderStore } from "@renderer/store/reader-store";
import { ChipBar } from "@renderer/ai/ChipBar";

interface Props {
  status: ChatStatus;
  onSend: (text: string, chips: Chip[]) => void;
  onStop: () => void;
}

export function Composer({ status, onSend, onStop }: Props) {
  const draftText = useReaderStore((s) => s.draftText);
  const draftChips = useReaderStore((s) => s.draftChips);
  const setDraftText = useReaderStore((s) => s.setDraftText);
  const setDraftChips = useReaderStore((s) => s.setDraftChips);
  const panelOpen = useReaderStore((s) => s.panelOpen);
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
          placeholder="问点什么…（Enter 发送，Shift+Enter 换行）"
          className="max-h-32 min-h-9 flex-1 resize-none overflow-y-auto bg-transparent px-1 py-1 text-sm outline-none placeholder:text-muted-foreground"
        />
        {isStreaming ? (
          <button
            onClick={onStop}
            aria-label="停止"
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-secondary text-secondary-foreground hover:opacity-90"
          >
            <Square className="size-4" />
          </button>
        ) : (
          <button
            onClick={send}
            disabled={draftText.trim() === ""}
            aria-label="发送"
            className="grid size-9 shrink-0 place-items-center rounded-lg bg-primary text-primary-foreground hover:opacity-90 disabled:opacity-50"
          >
            <ArrowUp className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
