// src/main/ipc/chat-handlers.ts
import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import { buildChips } from "@main/ai/chips";
import {
  createConversation,
  getConversation,
  listConversationsByBook,
} from "@main/chat/conversations";
import { listMessages } from "@main/chat/messages";
import { bind, register, type Binding } from "@main/ipc/registry";

export const chatBindings: Binding[] = [
  bind(C.conversationsListByBook, (input) => listConversationsByBook(getDb(), input.bookId)),
  bind(C.conversationsCreate, (input) => createConversation(getDb(), input)),
  bind(C.conversationsGet, (input) => getConversation(getDb(), input.id)),
  bind(C.messagesListByConversation, (input) => listMessages(getDb(), input.conversationId)),
  bind(C.aiBuildChips, buildChips),
];

export function registerChatHandlers(): void {
  register(chatBindings);
}
