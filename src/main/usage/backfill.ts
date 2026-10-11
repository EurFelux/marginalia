import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { conversations, messages } from "@main/db/schema";
import { getAppMeta, setAppMeta } from "@main/app-meta/repository";
import { insertUsage } from "@main/usage/ledger";
import { createLogger } from "@main/logger";
import { messageUsageSchema } from "@shared/types";

const log = createLogger("usage");

/**
 * 首次启动新版本时，把历史助手消息的 metadata.usage 回填进用量账本，只做一次
 * （spec 2026-10-12-ai-usage-stats-design §4.4）。回填与完成标记同一事务：中途失败不半填，下次重来。
 * 回填补不回后台调用的历史，也补不回已删除的消息。
 */
export function backfillUsageLedger(db: DB): void {
  if (getAppMeta(db, "usageLedgerBackfilled") === true) return;
  const { written, skipped } = db.transaction((tx) => {
    const rows = tx
      .select({
        createdAt: messages.createdAt,
        metadata: messages.metadata,
        bookId: conversations.bookId,
      })
      .from(messages)
      .innerJoin(conversations, eq(messages.conversationId, conversations.id))
      .where(eq(messages.role, "assistant"))
      .all();
    let written = 0;
    let skipped = 0;
    for (const row of rows) {
      if (row.metadata?.usage == null) continue;
      // 读出的是未经校验的 JSON 列：形状不合就跳过这一条，不让一条脏数据挡住整个回填
      const parsed = messageUsageSchema.safeParse(row.metadata.usage);
      if (!parsed.success) {
        skipped += 1;
        continue;
      }
      const u = parsed.data;
      insertUsage(tx, {
        createdAt: row.createdAt,
        purpose: "chat",
        model: row.metadata.model ?? null,
        bookId: row.bookId,
        requests: u.stepCount ?? 1,
        inputTokens: u.inputTokens,
        outputTokens: u.outputTokens,
        cacheReadTokens: u.cacheReadTokens ?? null,
        cacheWriteTokens: u.cacheWriteTokens ?? null,
        noCacheTokens: u.noCacheTokens ?? null,
        reasoningTokens: u.reasoningTokens ?? null,
      });
      written += 1;
    }
    setAppMeta(tx, "usageLedgerBackfilled", true);
    return { written, skipped };
  });
  if (skipped > 0) log.warn(`skipped ${skipped} messages with malformed usage during backfill`);
  log.info(`backfilled ${written} usage rows from chat history`);
}
