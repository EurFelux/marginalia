import type { MessageDto } from "@shared/chat";
import type { ChatUIMessage } from "@renderer/ai/types";

/**
 * 持久化 MessageDto → useChat 的 ChatUIMessage。
 * MVP 只取 id/role/parts：parts 本就是 UIMessage["parts"]，role(MessageRole) ⊆ UIMessage role；
 * 故意省略 metadata——持久化 metadata.contextChips 是快照投影（缺 labelKey），与 live ChatMetadata.contextChips(Chip[]) 不同型，
 * 历史只看 parts 即可（历史用户气泡不重渲 chip 徽标是 MVP 有意取舍）。
 */
export function messageDtoToUIMessage(dto: MessageDto): ChatUIMessage {
  return { id: dto.id, role: dto.role, parts: dto.parts };
}

export function messagesToUI(dtos: MessageDto[]): ChatUIMessage[] {
  return dtos.map(messageDtoToUIMessage);
}
