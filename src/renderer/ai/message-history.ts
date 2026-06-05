import type { Chip, MessageDto } from "@shared/chat";
import type { ChatUIMessage } from "@renderer/ai/types";

type ChipSnapshot = NonNullable<NonNullable<MessageDto["metadata"]>["contextChips"]>[number];

/** 快照 id → labelKey（与主进程 buildChips / renderer 摘要 chip 物化的取值一一对应）。 */
const LABEL_KEY: Record<ChipSnapshot["id"], string> = {
  selection: "chip.selection",
  paragraph: "chip.paragraph",
  "chapter-summary": "chip.chapterSummary",
  "book-summary": "chip.bookSummary",
};

/**
 * 持久化快照 {id,content,tokenCount} → live Chip：labelKey 由 id 反推；
 * 能落库的 chip 必然实际发送过，历史不可交互，一律水合为 required。
 */
function hydrateChip(snapshot: ChipSnapshot): Chip {
  return { ...snapshot, labelKey: LABEL_KEY[snapshot.id], state: "required" };
}

/**
 * 持久化 MessageDto → useChat 的 ChatUIMessage。
 * parts 本就是 UIMessage["parts"]，role(MessageRole) ⊆ UIMessage role；
 * metadata.contextChips 由快照水合回 live Chip，使重开会话后历史用户气泡重渲 chip 徽标。
 */
export function messageDtoToUIMessage(dto: MessageDto): ChatUIMessage {
  const chips = dto.metadata?.contextChips;
  const base: ChatUIMessage = { id: dto.id, role: dto.role, parts: dto.parts };
  if (chips && chips.length > 0) base.metadata = { contextChips: chips.map(hydrateChip) };
  return base;
}

export function messagesToUI(dtos: MessageDto[]): ChatUIMessage[] {
  return dtos.map(messageDtoToUIMessage);
}
