// src/main/ai/summary.ts
import { generateText } from "ai";
import { and, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { chapters } from "@main/db/schema";
import { readChapterText } from "@main/library/content";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { LoadBytes } from "@main/ai/tools";

export const SUMMARY_SYSTEM =
  "You summarize a single book chapter for a reading assistant. Produce a concise, faithful summary (a few sentences) capturing the chapter's key events, ideas, and terms. Output only the summary, no preamble.";

const SUMMARY_INPUT_MAX_CHARS = 12_000; // 截断喂模型的章节正文（拉丁文约 3k tokens、CJK 最多约 12k），避免爆上下文

export interface SummaryDeps {
  db: DB;
  loadBytes: LoadBytes;
  resolveModel: () => ResolvedModel;
}

// 进程内并发去重：同一章节正在生成时，后续调用直接跳过。
const inFlight = new Set<string>();

/** 懒生成某章摘要（设计文档 §11）。仅从 pending 触发；非阻塞调用方 fire-and-forget。 */
export async function ensureChapterSummary(
  deps: SummaryDeps,
  bookId: string,
  chapterId: string,
): Promise<void> {
  const { db, loadBytes, resolveModel } = deps;
  let claimed = false;
  try {
    const row = db
      .select({ status: chapters.summaryStatus })
      .from(chapters)
      .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
      .get();
    if (!row || row.status !== "pending") return; // 仅从 pending 生成
    if (inFlight.has(chapterId)) return; // 并发去重
    const resolved = resolveModel();
    if (!resolved.ok) return; // 模型未配置 → 保持 pending，配置后重试

    inFlight.add(chapterId);
    claimed = true;
    db.update(chapters)
      .set({ summaryStatus: "generating" })
      .where(eq(chapters.id, chapterId))
      .run();
    const bytes = await loadBytes(bookId);
    const slice = readChapterText(db, bytes, bookId, chapterId, {
      maxChars: SUMMARY_INPUT_MAX_CHARS,
    });
    const { text } = await generateText({
      model: resolved.model,
      system: SUMMARY_SYSTEM,
      prompt: slice.text,
      maxOutputTokens: 512,
      maxRetries: 1,
    });
    db.update(chapters)
      .set({ summary: text, summaryStatus: "ready" })
      .where(eq(chapters.id, chapterId))
      .run();
  } catch (err) {
    // 自含全部 reject（fire-and-forget 端口为 => void）。已 claim 的标记 unavailable；标记本身也防御性 guard。
    console.warn(`[summary] chapter ${chapterId} ensure failed:`, err);
    if (claimed) {
      try {
        db.update(chapters)
          .set({ summaryStatus: "unavailable" })
          .where(eq(chapters.id, chapterId))
          .run();
      } catch (markErr) {
        console.warn(`[summary] chapter ${chapterId} could not be marked unavailable:`, markErr);
      }
    }
  } finally {
    if (claimed) inFlight.delete(chapterId);
  }
}

/**
 * 启动恢复：把上次进程崩溃残留的 "generating" 复位为 "pending"，否则该章摘要因 pending-check
 * 永不重试。应用启动（initDb）时调用一次。inFlight 是进程内态，重启即清空，故只需复位 DB。
 */
export function resetStuckSummaries(db: DB): void {
  db.update(chapters)
    .set({ summaryStatus: "pending" })
    .where(eq(chapters.summaryStatus, "generating"))
    .run();
}
