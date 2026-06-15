// src/renderer/ai/chat-context.ts —— Lia 的上下文脊柱（spec 2026-06-16 §2/§5）。
export type ChatContext = { kind: "book"; bookId: string } | { kind: "library" };

/** 稳定 key：用于 chat-store 槽、TanStack Query key。 */
export function contextKey(ctx: ChatContext): string {
  return ctx.kind === "book" ? `book:${ctx.bookId}` : "library";
}

/** 由导航派生上下文：阅读器且有书 ⇒ book；否则 ⇒ library。 */
export function deriveChatContext(
  view: "library" | "stats" | "reader",
  currentBookId: string | null,
): ChatContext {
  return view === "reader" && currentBookId
    ? { kind: "book", bookId: currentBookId }
    : { kind: "library" };
}
