// src/renderer/ai/chat-context.ts —— AI 助手的上下文脊柱（spec 2026-06-16 §2/§5）。
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

/**
 * 一次性「载入某会话历史」命令信号（非状态）：nonce 递增触发面板载入。
 * 带 `context` 标签——消费侧据此判断该命令是否属于自己（见 resolveOpenCommandTarget）。
 */
export type OpenCommand = { conversationId: string; context: ChatContext; nonce: number };

/**
 * 消费侧守卫（纯函数）：openCommand 是否该被「contextKey === panelKey 的面板」消费。
 * 命中 ⇒ 返回要载入的会话 id；否则（无命令 / 跨 context）⇒ null。
 * 防止读书时设下的 book 会话命令泄漏进 library 浮窗助手（反之亦然）。
 *
 * 取面板的 contextKey **字符串**（而非 context 对象）是有意为之：调用方据此可让 effect 依赖
 * 稳定的字符串，不受 ReaderView 每 render 新建 `{ kind, bookId }` 对象的引用抖动影响——
 * effect 正确性不能押在 React Compiler 的记忆化上（它是性能优化、允许 bail）。
 */
export function resolveOpenCommandTarget(
  openCommand: OpenCommand | null,
  panelKey: string,
): string | null {
  if (!openCommand) return null;
  return contextKey(openCommand.context) === panelKey ? openCommand.conversationId : null;
}
