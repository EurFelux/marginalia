import type { UIMessage } from "ai";
import type { Chip } from "@shared/chat";
import type { MessageStatus, MessageUsage } from "@shared/types";

/**
 * 渲染层活跃对话 UIMessage 的元数据：随用户消息携带本轮上下文 chips（live 形态），
 * 并携带消息时刻（历史由 MessageDto.createdAt 水合；live 消息渲染时回退到当前时刻）。
 */
export interface ChatMetadata {
  contextChips?: Chip[];
  /** epoch ms。 */
  createdAt?: number;
  /** assistant 行：本轮用量、模型与终态，供用量卡显示（由 MessageDto 水合；流式途中的 live 消息没有）。 */
  usage?: MessageUsage;
  model?: string;
  status?: MessageStatus;
}

/** useChat / transport 全程使用的消息类型。 */
export type ChatUIMessage = UIMessage<ChatMetadata>;
