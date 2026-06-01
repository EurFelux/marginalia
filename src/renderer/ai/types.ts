import type { UIMessage } from "ai";
import type { Chip } from "@shared/chat";

/** 渲染层活跃对话 UIMessage 的元数据：随用户消息携带本轮上下文 chips（live 形态）。 */
export interface ChatMetadata {
  contextChips?: Chip[];
}

/** useChat / transport 全程使用的消息类型。 */
export type ChatUIMessage = UIMessage<ChatMetadata>;
