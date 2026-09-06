import type { UIMessage } from "ai";
import type { Chip } from "@shared/chat";

/**
 * 渲染层活跃对话 UIMessage 的元数据：随用户消息携带本轮上下文 chips（live 形态），
 * 并携带消息时刻（历史由 MessageDto.createdAt 水合；live 消息渲染时回退到当前时刻）。
 */
export interface ChatMetadata {
  contextChips?: Chip[];
  /** epoch ms。 */
  createdAt?: number;
}

/** useChat / transport 全程使用的消息类型。 */
export type ChatUIMessage = UIMessage<ChatMetadata>;
