import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { progress } from "@main/db/schema";

export type ProgressRow = typeof progress.$inferSelect;

export function getProgress(db: DB, bookId: string): ProgressRow | undefined {
  return db.select().from(progress).where(eq(progress.bookId, bookId)).get();
}

export function saveProgress(db: DB, bookId: string, cfi: string): void {
  db.insert(progress)
    .values({ bookId, cfi, updatedAt: Date.now() })
    .onConflictDoUpdate({ target: progress.bookId, set: { cfi, updatedAt: Date.now() } })
    .run();
}
