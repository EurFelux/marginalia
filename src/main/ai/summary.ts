// src/main/ai/summary.ts
import { generateText } from "ai";
import { and, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { books, chapters } from "@main/db/schema";
import { readBookText, readChapterText } from "@main/library/content";
import type { SummaryStatus } from "@shared/library";
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

export const BOOK_SUMMARY_SYSTEM =
  "You summarize an entire book for a reading assistant. Produce a faithful, multi-paragraph summary covering the book's core themes, main characters, and overall structure/arc. Output only the summary, no preamble.";

const BOOK_SUMMARY_INPUT_MAX_CHARS = 180_000; // 喂模型的全书正文上限（适配 200k 上下文摘要模型；超长书前载截断）

// 全书摘要的运行时状态（不持久化；重启清空）：summary!=null=ready，inFlight=generating，failed=unavailable，否则 pending。
const inFlightBooks = new Set<string>();
const failedBooks = new Set<string>();

/** 读全书摘要正文 + 派生状态（状态不入 DB，由 summary 存在性 + 进程内集派生）。 */
export function getBookSummaryView(
  db: DB,
  bookId: string,
): { status: SummaryStatus; summary: string | null } {
  const row = db.select({ summary: books.summary }).from(books).where(eq(books.id, bookId)).get();
  if (!row) throw new Error(`summary: book ${bookId} not found`);
  const summary = row.summary ?? null;
  // inFlight 优先于 summary 存在性：重新生成（旧 summary 还在 + 正在重生）应显示 generating。
  const status: SummaryStatus = inFlightBooks.has(bookId)
    ? "generating"
    : summary != null
      ? "ready"
      : failedBooks.has(bookId)
        ? "unavailable"
        : "pending";
  return { status, summary };
}

/** 仅供测试：清空全书摘要的进程内运行时态（inFlight/failed），保证用例隔离（book.id 由 fixture 确定、跨用例相同）。 */
export function __resetBookSummaryRuntime(): void {
  inFlightBooks.clear();
  failedBooks.clear();
}

/** 懒生成全书摘要（用户决策「直接喂整本书」）。仅在未 ready 时生成；非阻塞调用方 fire-and-forget。 */
export async function ensureBookSummary(deps: SummaryDeps, bookId: string): Promise<void> {
  const { db, loadBytes, resolveModel } = deps;
  let claimed = false;
  try {
    if (getBookSummaryView(db, bookId).summary != null) return; // 已 ready
    if (inFlightBooks.has(bookId)) return; // 并发去重
    const resolved = resolveModel();
    if (!resolved.ok) return; // 模型未配置 → 保持 pending，配置后重试

    failedBooks.delete(bookId);
    inFlightBooks.add(bookId); // 同步前缀：使 generate handler 即时派生出 generating
    claimed = true;
    const bytes = await loadBytes(bookId);
    const { text } = readBookText(db, bytes, bookId, { maxChars: BOOK_SUMMARY_INPUT_MAX_CHARS });
    const { text: summary } = await generateText({
      model: resolved.model,
      system: BOOK_SUMMARY_SYSTEM,
      prompt: text,
      maxOutputTokens: 4096, // 全书摘要（主题/人物/结构、多段）比单章长，给足额度避免输出截断
      maxRetries: 1,
    });
    db.update(books).set({ summary }).where(eq(books.id, bookId)).run();
  } catch (err) {
    // 自含全部 reject（端口 => void）。失败标记进程内 failedBooks（→ 派生 unavailable；重启清空即可重试）。
    console.warn(`[summary] book ${bookId} ensure failed:`, err);
    if (claimed) failedBooks.add(bookId);
  } finally {
    if (claimed) inFlightBooks.delete(bookId);
  }
}

/**
 * 启动恢复：把上次进程崩溃残留的 "generating" 复位为 "pending"，否则该章摘要因 pending-check
 * 永不重试。应用启动（initDb）时调用一次。inFlight 是进程内态，重启即清空，故只需复位 DB。
 * 注：全书摘要无需此复位——其状态本就运行时派生，重启时 inFlightBooks 自然为空。
 */
export function resetStuckSummaries(db: DB): void {
  db.update(chapters)
    .set({ summaryStatus: "pending" })
    .where(eq(chapters.summaryStatus, "generating"))
    .run();
}
