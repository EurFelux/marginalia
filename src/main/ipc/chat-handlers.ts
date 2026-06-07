// src/main/ipc/chat-handlers.ts
import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import { buildChips } from "@main/ai/chips";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversationsByBook,
} from "@main/chat/conversations";
import { listMessages } from "@main/chat/messages";
import { abortConversationStreams } from "@main/ipc/ai-handlers";
import { bind, register, type Binding } from "@main/ipc/registry";

export const chatBindings: Binding[] = [
  bind(C.conversationsListByBook, (input) => listConversationsByBook(getDb(), input.bookId)),
  bind(C.conversationsCreate, (input) => createConversation(getDb(), input)),
  bind(C.conversationsGet, (input) => getConversation(getDb(), input.id)),
  bind(C.conversationsDelete, (input) => {
    // 先中止该会话的在跑流（防删行后继续推送/落库），再删行（messages 级联）。
    abortConversationStreams(input.id);
    deleteConversation(getDb(), input.id);
  }),
  bind(C.messagesListByConversation, (input) => listMessages(getDb(), input.conversationId)),
  bind(C.aiBuildChips, buildChips),
];

export function registerChatHandlers(): void {
  register(chatBindings);
}
