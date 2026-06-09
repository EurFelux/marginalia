import { desc, eq, sql } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { books, readingDaily } from "@main/db/schema";
import type { BookReadingTotal, DailyPoint } from "@shared/stats";

/** 累加某书某本地日的阅读秒数（upsert on (bookId, day)）。非正秒数忽略。 */
export function addSeconds(db: DB, bookId: string, day: string, seconds: number): void {
  if (seconds <= 0) return;
  db.insert(readingDaily)
    .values({ bookId, day, seconds })
    .onConflictDoUpdate({
      target: [readingDaily.bookId, readingDaily.day],
      set: { seconds: sql`${readingDaily.seconds} + ${seconds}` },
    })
    .run();
}

/** 每日合计（跨全部书，含已删书的 bookId=null 行），按 day 升序。 */
export function dailyTotals(db: DB): DailyPoint[] {
  return db
    .select({ day: readingDaily.day, seconds: sql<number>`sum(${readingDaily.seconds})` })
    .from(readingDaily)
    .groupBy(readingDaily.day)
    .orderBy(readingDaily.day)
    .all();
}

/** 各书合计，仅现存书（inner join 天然排除 bookId=null），按秒降序。 */
export function perBookTotals(db: DB): BookReadingTotal[] {
  return db
    .select({
      bookId: books.id,
      title: books.title,
      author: books.author,
      seconds: sql<number>`sum(${readingDaily.seconds})`,
    })
    .from(readingDaily)
    .innerJoin(books, eq(readingDaily.bookId, books.id))
    .groupBy(books.id)
    .orderBy(desc(sql`sum(${readingDaily.seconds})`))
    .all();
}
