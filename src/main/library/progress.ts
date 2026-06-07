import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { progress } from "@main/db/schema";

export type ProgressRow = typeof progress.$inferSelect;

export function getProgress(db: DB, bookId: string): ProgressRow | undefined {
  return db.select().from(progress).where(eq(progress.bookId, bookId)).get();
}

export function saveProgress(
  db: DB,
  bookId: string,
  locator: string,
  percent?: number | null,
): void {
  // percent 未传时写 null（而非保留旧值）：locator 与 percent 是同一位置的快照，半更新即脏数据。
  db.insert(progress)
    .values({ bookId, locator, percent: percent ?? null, updatedAt: Date.now() })
    .onConflictDoUpdate({
      target: progress.bookId,
      set: { locator, percent: percent ?? null, updatedAt: Date.now() },
    })
    .run();
}
