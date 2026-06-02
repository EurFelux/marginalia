/** 查询键工厂——与 spec §6.3 约定一致。 */
export const qk = {
  library: ["library"] as const,
  toc: (bookId: string) => ["toc", bookId] as const,
  chapters: (bookId: string) => ["chapters", bookId] as const,
  epubBytes: (bookId: string) => ["epub-bytes", bookId] as const,
  progress: (bookId: string) => ["progress", bookId] as const,
  chapterSummary: (bookId: string, chapterId: string) =>
    ["chapter-summary", bookId, chapterId] as const,
  providers: ["providers"] as const,
  assistantDefault: ["assistant", "default"] as const,
  conversations: (bookId: string) => ["conversations", bookId] as const,
  messages: (conversationId: string) => ["messages", conversationId] as const,
};
