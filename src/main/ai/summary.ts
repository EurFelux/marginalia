// src/main/ai/summary.ts
import { generateText, streamText } from "ai";
import { and, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { books, chapters } from "@main/db/schema";
import { readBookText, readChapterText } from "@main/library/content";
import type { SummaryStatus } from "@shared/library";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { LoadBytes } from "@main/ai/tools";

export const SUMMARY_SYSTEM =
  "You summarize a single book chapter for a reading assistant. Produce a concise, faithful summary (a few sentences) capturing the chapter's key events, ideas, and terms. Output only the summary, no preamble.";

const SUMMARY_INPUT_MAX_CHARS = 180_000; // 章节摘要输入预算（适配 200k 上下文摘要模型；超长章前载截断）

export interface SummaryDeps {
  db: DB;
  loadBytes: LoadBytes;
  resolveModel: () => ResolvedModel;
}

/**
 * 手动生成入口的预检（镜像聊天的发送前拦截）：模型未配置时抛带 reason 的错误，
 * 使 generate handler reject、渲染层 toast 透传真实原因（如「Provider 未设置密钥」）。
 * 没有它，ensure* 的 `!resolved.ok → return` 静默保持 pending——点击零反馈、零日志，无从排查。
 * 自动触发（开章）共用同一 handler，渲染层以 catch 静默消化，不弹窗。
 */
export function assertSummaryModelReady(resolveModel: () => ResolvedModel): void {
  const resolved = resolveModel();
  if (!resolved.ok) throw new Error(resolved.reason);
}

// 章节摘要的进程内运行时状态（不持久化；重启清空，镜像全书摘要）：
// 有效 summary=ready，inFlightChapters=generating，failedChapters=unavailable，否则 pending。
const inFlightChapters = new Set<string>();
const failedChapters = new Set<string>();

/**
 * 空/全空白文本不算有效摘要。provider 异常（content-filter、空 completion）可能不抛错而返回空文本，
 * 历史版本曾把它落库 → 派生 ready 永不重试；读取/skip 一律用本谓词，使既有脏行派生回 pending 自愈。
 */
function hasText(s: string | null | undefined): s is string {
  return s != null && s.trim() !== "";
}

/**
 * 读某章摘要正文 + 派生状态（状态不入 DB，镜像 getBookSummaryView）。
 * 章节摘要非流式，故 generating 无 partial（summary: null）。
 */
export function getChapterSummaryView(
  db: DB,
  bookId: string,
  chapterId: string,
): { status: SummaryStatus; summary: string | null } {
  const row = db
    .select({ summary: chapters.summary })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
  if (!row) throw new Error(`summary: chapter ${chapterId} not found in book ${bookId}`);
  if (inFlightChapters.has(chapterId)) return { status: "generating", summary: null };
  const summary = hasText(row.summary) ? row.summary : null;
  const status: SummaryStatus =
    summary != null ? "ready" : failedChapters.has(chapterId) ? "unavailable" : "pending";
  return { status, summary };
}

/** 仅供测试：清空章节摘要的进程内运行时态，保证用例隔离（chapter.id 由 fixture 确定、跨用例相同）。 */
export function __resetChapterSummaryRuntime(): void {
  inFlightChapters.clear();
  failedChapters.clear();
}

/**
 * 懒生成某章摘要（设计文档 §11；状态派生，不入 DB）。非阻塞调用方 fire-and-forget。
 * 失败章节下次触发会自动重试（开头清 failedChapters），重启后进程内集清空亦自愈——故无需 resetStuckSummaries。
 * `force=true`（pill「重新生成」）跳过 ready-skip、覆盖旧摘要；自动触发（开章）不传 force。
 */
export async function ensureChapterSummary(
  deps: SummaryDeps,
  bookId: string,
  chapterId: string,
  force = false,
): Promise<void> {
  const { db, loadBytes, resolveModel } = deps;
  let claimed = false;
  try {
    if (inFlightChapters.has(chapterId)) return; // 并发去重
    const stored = db
      .select({ summary: chapters.summary })
      .from(chapters)
      .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
      .get();
    if (!stored) return; // 章不存在
    if (!force && hasText(stored.summary)) return; // 已 ready，非强制跳过（空文本脏行不算，自愈重生成）
    const resolved = resolveModel();
    if (!resolved.ok) return; // 模型未配置 → 保持 pending，配置后重试

    failedChapters.delete(chapterId); // 清前次失败标记 → 可重试
    inFlightChapters.add(chapterId); // 同步前缀：使 generate handler 即时派生 generating
    claimed = true;
    const bytes = await loadBytes(bookId);
    const slice = await readChapterText(db, bytes, bookId, chapterId, {
      maxChars: SUMMARY_INPUT_MAX_CHARS,
    });
    const { text } = await generateText({
      model: resolved.model,
      system: SUMMARY_SYSTEM,
      prompt: slice.text,
      maxOutputTokens: 512,
      maxRetries: 1,
    });
    if (!hasText(text)) {
      // provider 不抛错但产出空文本 → 视为失败：不落库（否则派生 ready 永不重试），标 unavailable 可重试
      console.warn(`[summary] chapter ${chapterId} generated empty text, treated as failure`);
      failedChapters.add(chapterId);
      return;
    }
    db.update(chapters).set({ summary: text }).where(eq(chapters.id, chapterId)).run();
  } catch (err) {
    // 自含全部 reject（fire-and-forget 端口为 => void）。已 claim 的标记 failed（派生 unavailable）。
    console.warn(`[summary] chapter ${chapterId} ensure failed:`, err);
    if (claimed) failedChapters.add(chapterId);
  } finally {
    if (claimed) inFlightChapters.delete(chapterId);
  }
}

export const BOOK_SUMMARY_SYSTEM =
  "You summarize an entire book for a reading assistant. Produce a faithful, multi-paragraph summary covering the book's core themes, main characters, and overall structure/arc. Output only the summary, no preamble.";

const BOOK_SUMMARY_INPUT_MAX_CHARS = 180_000; // 喂模型的全书正文上限（适配 200k 上下文摘要模型；超长书前载截断）

// 全书摘要的运行时状态（不持久化；重启清空）：summary!=null=ready，inFlight=generating，failed=unavailable，否则 pending。
const inFlightBooks = new Set<string>();
const failedBooks = new Set<string>();
const streamingBookSummaries = new Map<string, string>(); // 生成中累积的 partial 文本（供流式渲染）

/**
 * 读全书摘要正文 + 派生状态（状态不入 DB）。
 * 生成中（inFlight）返回累积的 partial（供 BookCard 用 Streamdown 流式渲染），状态 generating——
 * inFlight 优先于 summary 存在性，故重新生成（旧 summary 还在）也显示 generating + 流式新文本。
 */
export function getBookSummaryView(
  db: DB,
  bookId: string,
): { status: SummaryStatus; summary: string | null } {
  const row = db.select({ summary: books.summary }).from(books).where(eq(books.id, bookId)).get();
  if (!row) throw new Error(`summary: book ${bookId} not found`);
  if (inFlightBooks.has(bookId)) {
    return { status: "generating", summary: streamingBookSummaries.get(bookId) ?? null };
  }
  const summary = hasText(row.summary) ? row.summary : null;
  const status: SummaryStatus =
    summary != null ? "ready" : failedBooks.has(bookId) ? "unavailable" : "pending";
  return { status, summary };
}

/** 仅供测试：清空全书摘要的进程内运行时态，保证用例隔离（book.id 由 fixture 确定、跨用例相同）。 */
export function __resetBookSummaryRuntime(): void {
  inFlightBooks.clear();
  failedBooks.clear();
  streamingBookSummaries.clear();
}

/**
 * 懒生成全书摘要（用户决策「直接喂整本书」），**流式**累积 partial 供渲染。
 * `force=true`（书卡「重新生成」）跳过 ready-skip、覆盖旧摘要。非阻塞调用方 fire-and-forget。
 */
export async function ensureBookSummary(
  deps: SummaryDeps,
  bookId: string,
  force = false,
): Promise<void> {
  const { db, loadBytes, resolveModel } = deps;
  let claimed = false;
  try {
    if (inFlightBooks.has(bookId)) return; // 并发去重
    const stored = db
      .select({ summary: books.summary })
      .from(books)
      .where(eq(books.id, bookId))
      .get();
    if (!force && hasText(stored?.summary)) return; // 已 ready，非强制跳过（空文本脏行不算，自愈重生成）
    const resolved = resolveModel();
    if (!resolved.ok) return; // 模型未配置 → 保持 pending，配置后重试

    failedBooks.delete(bookId);
    streamingBookSummaries.delete(bookId);
    inFlightBooks.add(bookId); // 同步前缀：使 generate handler 即时派生出 generating
    claimed = true;
    const bytes = await loadBytes(bookId);
    const { text } = await readBookText(db, bytes, bookId, {
      maxChars: BOOK_SUMMARY_INPUT_MAX_CHARS,
    });
    // streamText 遇错发 error chunk 并正常关流（textStream 不 throw），故用 onError 标志兜——否则会把半截落库。
    let hadError = false;
    const result = streamText({
      model: resolved.model,
      system: BOOK_SUMMARY_SYSTEM,
      prompt: text,
      maxOutputTokens: 4096, // 全书摘要（主题/人物/结构、多段）比单章长，给足额度避免输出截断
      maxRetries: 1,
      onError: ({ error }) => {
        hadError = true;
        console.warn(`[summary] book ${bookId} stream error:`, error);
      },
    });
    let acc = "";
    for await (const delta of result.textStream) {
      acc += delta;
      streamingBookSummaries.set(bookId, acc); // partial 供 getBookSummaryView 轮询读取
    }
    if (hadError || !hasText(acc)) {
      // 流错误或空产出（provider 不报错但 0 字符）均不落库（保留旧 summary 不变），标 failed 可重试
      if (!hadError)
        console.warn(`[summary] book ${bookId} generated empty text, treated as failure`);
      failedBooks.add(bookId);
    } else db.update(books).set({ summary: acc }).where(eq(books.id, bookId)).run();
  } catch (err) {
    console.warn(`[summary] book ${bookId} ensure failed:`, err);
    if (claimed) failedBooks.add(bookId);
  } finally {
    if (claimed) {
      inFlightBooks.delete(bookId);
      streamingBookSummaries.delete(bookId); // partial 已落库或丢弃
    }
  }
}
