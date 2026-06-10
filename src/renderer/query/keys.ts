/** 查询键工厂——与 spec §6.3 约定一致。 */
export const qk = {
  library: ["library"] as const,
  toc: (bookId: string) => ["toc", bookId] as const,
  chapters: (bookId: string) => ["chapters", bookId] as const,
  bookBytes: (bookId: string) => ["book-bytes", bookId] as const,
  progress: (bookId: string) => ["progress", bookId] as const,
  annotations: (bookId: string) => ["annotations", bookId] as const,
  chapterSummary: (bookId: string, chapterId: string) =>
    ["chapter-summary", bookId, chapterId] as const,
  book: (bookId: string) => ["book", bookId] as const,
  bookSummary: (bookId: string) => ["book-summary", bookId] as const,
  recentlyRead: ["recently-read"] as const,
  providers: ["providers"] as const,
  conversations: (bookId: string) => ["conversations", bookId] as const,
  messages: (conversationId: string) => ["messages", conversationId] as const,
  stats: (dailyDays: number) => ["stats", dailyDays] as const,
  memories: ["memories"] as const,
};
