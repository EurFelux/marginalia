import { useEffect, useRef, type KeyboardEvent } from "react";
import type { ChatStatus } from "ai";
import { useQuery } from "@tanstack/react-query";
import { ArrowUp, Square } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { Chip } from "@shared/chat";
import { Button } from "@renderer/components/ui/button";
import { isSubmitEnter } from "@renderer/lib/keyboard";
import { useChatStore } from "@renderer/store/chat-store";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { registerComposerFocus } from "@renderer/ai/composer-focus";
import { ContextPillBar } from "@renderer/ai/ContextPillBar";
import { materializeSummaryChips } from "@renderer/ai/summary-chips";
import { bookSummaryQuery, chapterSummaryQuery } from "@renderer/query/summary-queries";

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
  const summaryChips = useChatStore((s) => s.summaryChips);
  const bookId = useNavigationStore((s) => s.currentBookId);
  const chapterId = useNavigationStore((s) => s.currentChapterId);
  const ref = useRef<HTMLTextAreaElement | null>(null);
  const isStreaming = status === "streaming" || status === "submitted";

  useEffect(() => {
    registerComposerFocus(() => {
      const el = ref.current;
      if (!el) return;
      el.focus({ preventScroll: true });
      // 光标置末尾：预设提示语场景可直接 Enter 或追加，符合直觉
      const end = el.value.length;
      el.setSelectionRange(end, end);
    });
    return () => registerComposerFocus(null);
  }, []);

  const chapterSummary = useQuery({
    ...chapterSummaryQuery(bookId ?? "", chapterId ?? ""),
    enabled: !!bookId && !!chapterId,
  });
  const bookSummary = useQuery({ ...bookSummaryQuery(bookId ?? ""), enabled: !!bookId });

  const send = () => {
    const text = draftText.trim();
    if (!text || isStreaming) return;
    const summaryExtras = materializeSummaryChips(
      summaryChips,
      chapterSummary.data,
      bookSummary.data,
    );
    onSend(text, [...summaryExtras, ...draftChips]);
    setDraftText("");
    setDraftChips([]);
    // 已随本条发送的摘要回落 off（一段对话只输入一次）；未 ready 被 materialize 跳过的保持 on
    const sent = new Set(summaryExtras.map((c) => c.id));
    const { setSummaryChip } = useChatStore.getState();
    if (sent.has("chapter-summary")) setSummaryChip("chapter", false);
    if (sent.has("book-summary")) setSummaryChip("book", false);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (isSubmitEnter(e)) {
      e.preventDefault();
      send();
    }
  };

  return (
    <div className="shrink-0 border-t border-border bg-card/40 p-3">
      <ContextPillBar />
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
