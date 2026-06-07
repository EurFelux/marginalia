import { sql } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { books } from "@main/db/schema";
import type { AppGetInfoResult, PingInput, PingResult } from "@shared/ipc";

export function ping(input: PingInput): PingResult {
  return { echo: input.msg };
}

export function getAppInfo(db: DB, version: string): AppGetInfoResult {
  const row = db
    .select({ c: sql<number>`count(*)` })
    .from(books)
    .get();
  return { version, bookCount: row?.c ?? 0 };
}
