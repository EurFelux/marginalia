// src/renderer/query/conversation-queries.ts
import type { ConversationDto } from "@shared/chat";
import { qk } from "@renderer/query/keys";

type IntervalQuery = { state: { data?: ConversationDto[] } };

/**
 * 会话列表 query（ConversationsTab / AIPanel header 共用）。isNaming 是主进程后台推进的
 * 进程内瞬态（spec §5/§8）：staleTime:0 防缓存冻结，命名期间短轮询、终态（无 isNaming）即停
 * ——镜像 summary-queries 的非终态轮询取向。
 */
export function conversationsQuery(bookId: string) {
  return {
    queryKey: qk.conversations(bookId),
    queryFn: (): Promise<ConversationDto[]> => window.api.chat.conversations.listByBook({ bookId }),
    staleTime: 0,
    refetchInterval: (q: IntervalQuery) => (q.state.data?.some((c) => c.isNaming) ? 1200 : false),
  } as const;
}
