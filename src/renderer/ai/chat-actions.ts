import { createContext, useContext } from "react";
import type { ChatUIMessage } from "@renderer/ai/types";

export interface ChatActions {
  /** 直接重发：重跑某 user 轮的回复（不改文本）。 */
  resend(userMessage: ChatUIMessage): void;
  /** 编辑重发：改 user 文本后重跑回复。 */
  editAndResend(userMessage: ChatUIMessage, newText: string): void;
  /** 再生成某 assistant 回复。 */
  regenerate(assistantMessage: ChatUIMessage): void;
  /** 有流在跑时为 true（禁用操作按钮）。 */
  busy: boolean;
}

export const ChatActionsContext = createContext<ChatActions | null>(null);

export function useChatActions(): ChatActions {
  const ctx = useContext(ChatActionsContext);
  if (!ctx) throw new Error("useChatActions must be used within ChatActionsContext.Provider");
  return ctx;
}

/** messages 中 userMessageId 之后紧邻的 assistant 消息 id（无则 undefined）。 */
export function nextAssistantId(
  messages: ChatUIMessage[],
  userMessageId: string,
): string | undefined {
  const i = messages.findIndex((m) => m.id === userMessageId);
  if (i < 0) return undefined;
  const next = messages[i + 1];
  return next?.role === "assistant" ? next.id : undefined;
}
