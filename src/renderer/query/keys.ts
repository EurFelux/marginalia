/** 查询键工厂——与 spec §6.3 约定一致。 */
export const qk = {
  library: ["library"] as const,
  toc: (bookId: string) => ["toc", bookId] as const,
  chapter: (bookId: string, chapterId: string) => ["chapter", bookId, chapterId] as const,
  providers: ["providers"] as const,
  assistantDefault: ["assistant", "default"] as const,
  conversations: (bookId: string) => ["conversations", bookId] as const,
  messages: (conversationId: string) => ["messages", conversationId] as const,
};
