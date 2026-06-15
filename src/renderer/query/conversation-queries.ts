// src/renderer/query/conversation-queries.ts
import type { ConversationDto } from "@shared/chat";
import { qk } from "@renderer/query/keys";
import { type ChatContext, contextKey } from "@renderer/ai/chat-context";

type IntervalQuery = { state: { data?: ConversationDto[] } };

/** 会话列表 query（按上下文）；book→bookId，library→null。key 用 contextKey 区分。 */
export function conversationsQuery(ctx: ChatContext) {
  const bookId = ctx.kind === "book" ? ctx.bookId : null;
  return {
    queryKey: qk.conversations(contextKey(ctx)),
    queryFn: (): Promise<ConversationDto[]> => window.api.chat.conversations.listByBook({ bookId }),
    staleTime: 0,
    refetchInterval: (q: IntervalQuery) => (q.state.data?.some((c) => c.isNaming) ? 1200 : false),
  } as const;
}
