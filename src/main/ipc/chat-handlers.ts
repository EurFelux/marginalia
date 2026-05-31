// src/main/ipc/chat-handlers.ts
import { IPC } from "@shared/ipc";
import { bookIdInput } from "@shared/library";
import {
  buildChipsInput,
  conversationIdInput,
  createConversationInput,
  messagesByConversationInput,
  type BuildChipsInput,
  type Chip,
  type ConversationDto,
  type CreateConversationInput,
  type MessageDto,
} from "@shared/chat";
import { getDb } from "@main/db/instance";
import { buildChips } from "@main/ai/chips";
import {
  createConversation,
  getConversation,
  listConversationsByBook,
} from "@main/chat/conversations";
import { listMessages } from "@main/chat/messages";
import { handle } from "@main/ipc/registry";

export function registerChatHandlers(): void {
  handle<{ bookId: string }, ConversationDto[]>(IPC.conversationsListByBook, bookIdInput, (input) =>
    listConversationsByBook(getDb(), input.bookId),
  );

  handle<CreateConversationInput, ConversationDto>(
    IPC.conversationsCreate,
    createConversationInput,
    (input) => createConversation(getDb(), input),
  );

  handle<{ id: string }, ConversationDto | null>(
    IPC.conversationsGet,
    conversationIdInput,
    (input) => getConversation(getDb(), input.id),
  );

  handle<{ conversationId: string }, MessageDto[]>(
    IPC.messagesListByConversation,
    messagesByConversationInput,
    (input) => listMessages(getDb(), input.conversationId),
  );

  handle<BuildChipsInput, Chip[]>(IPC.aiBuildChips, buildChipsInput, buildChips);
}
