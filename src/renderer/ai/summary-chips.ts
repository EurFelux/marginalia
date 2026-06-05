// src/renderer/ai/summary-chips.ts
import type { Chip } from "@shared/chat";
import type { SummaryStatus } from "@shared/library";
import { estimateTokens } from "@shared/tokens";

export interface SummaryView {
  status: SummaryStatus;
  summary: string | null;
}

/**
 * 把 enabled 的摘要 toggle 物化为随消息发送的 live Chip（spec §6）：
 * 仅 ready 且有正文的摘要物化；未 ready 的跳过（不阻塞发送，toggle 保持 on 等下一条）。
 * content 为发送时快照——之后重新生成摘要不影响已发送消息。
 */
export function materializeSummaryChips(
  enabled: { chapter: boolean; book: boolean },
  chapter: SummaryView | undefined,
  book: SummaryView | undefined,
): Chip[] {
  const chips: Chip[] = [];
  if (enabled.book && book?.status === "ready" && book.summary) {
    chips.push({
      id: "book-summary",
      labelKey: "chip.bookSummary",
      content: book.summary,
      tokenCount: estimateTokens(book.summary),
      state: "on",
    });
  }
  if (enabled.chapter && chapter?.status === "ready" && chapter.summary) {
    chips.push({
      id: "chapter-summary",
      labelKey: "chip.chapterSummary",
      content: chapter.summary,
      tokenCount: estimateTokens(chapter.summary),
      state: "on",
    });
  }
  return chips;
}
