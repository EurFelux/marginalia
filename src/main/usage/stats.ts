import { gte, inArray } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { aiUsage, books } from "@main/db/schema";
import { aggregateUsage, usageRangeStart, type BookInfo } from "@main/usage/aggregate";
import type { UsageRange, UsageStatsDto } from "@shared/stats";

/** 读账本并聚合成统计页「AI 用量」数据（注入 DB 与当前时刻，读时钟留在胶水层）。 */
export function usageStats(db: DB, range: UsageRange, now: Temporal.ZonedDateTime): UsageStatsDto {
  const start = usageRangeStart(range, now);
  const rows = db
    .select({
      createdAt: aiUsage.createdAt,
      purpose: aiUsage.purpose,
      model: aiUsage.model,
      bookId: aiUsage.bookId,
      requests: aiUsage.requests,
      inputTokens: aiUsage.inputTokens,
      outputTokens: aiUsage.outputTokens,
      cacheReadTokens: aiUsage.cacheReadTokens,
    })
    .from(aiUsage)
    .where(start == null ? undefined : gte(aiUsage.createdAt, start))
    .all();
  const hasAnyUsage =
    rows.length > 0 || db.select({ id: aiUsage.id }).from(aiUsage).limit(1).get() != null;

  // 只查账本里出现过的书；查不到的即已删除
  const bookIds = [...new Set(rows.flatMap((r) => (r.bookId == null ? [] : [r.bookId])))];
  const found =
    bookIds.length === 0
      ? []
      : db
          .select({ id: books.id, title: books.title, author: books.author })
          .from(books)
          .where(inArray(books.id, bookIds))
          .all();
  const bookInfo = new Map<string, BookInfo>(
    found.map((b) => [b.id, { title: b.title, author: b.author }]),
  );
  return aggregateUsage(rows, range, now, bookInfo, hasAnyUsage);
}
