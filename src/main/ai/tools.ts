// src/main/ai/tools.ts
import { tool } from "ai";
import { z } from "zod";
import { and, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { chapters } from "@main/db/schema";
import { listChapters, readChapterText } from "@main/library/content";
import { getChapterSummaryView } from "@main/ai/summary";
import { getBook, resolveChapterByHref } from "@main/library/repository";
import { extractPdfText, renderPageImage } from "@marginalia/pdf-parser";

/** 取某书原始字节（生产实现读 app 自有派生路径；测试注入 fixture 字节）。 */
export type LoadBytes = (bookId: string) => Promise<Uint8Array>;

export interface ReadingToolsDeps {
  db: DB;
  bookId: string;
  loadBytes: LoadBytes;
  /** provider 是否支持图像 tool result（readPage image 模式门控；spec §7）。缺省按不支持。 */
  imageToolResults?: boolean;
}

/** 给模型看的页面图像渲染宽度（px）：兼顾排版可读与 token 成本。 */
const READ_PAGE_IMAGE_WIDTH = 1280;

/**
 * 把模型给的章节引用解析成规范 chapterId。既接受代理 uuid（chapters.id），
 * 也接受 getToc 返回的 href，还容忍唯一命中的章节标题（大小写不敏感）——
 * 模型偶发把目录里的 href 或标题（如 "Preface"）当 id 传，宽容解析吸收这类偏差。
 * 解析失败的错误信息附带真实章节清单（自愈数据：tool result 透传后模型可据此重试）。
 */
export function resolveChapterRef(db: DB, bookId: string, ref: string): string {
  const byId = db
    .select({ id: chapters.id })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, ref)))
    .get();
  if (byId) return byId.id;
  const byHref = resolveChapterByHref(db, bookId, ref);
  if (byHref) return byHref.id;
  const all = db
    .select({ id: chapters.id, title: chapters.title })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .all();
  const wanted = ref.trim().toLowerCase();
  const byTitle = all.filter((c) => (c.title ?? "").trim().toLowerCase() === wanted);
  if (byTitle.length === 1) return byTitle[0]!.id;
  const sample = all
    .slice(0, 8)
    .map((c) => `${c.id} ("${c.title ?? "untitled"}")`)
    .join(", ");
  throw new Error(
    `chapter not found by id, href, or unique title: "${ref}". Call getToc and pass the exact id field. Known chapters include: ${sample}${all.length > 8 ? ", …" : ""}`,
  );
}

/**
 * tool 执行错误不抛、转 `{ error }` result：AI SDK v6 中 execute 抛错会中断整条流式
 * 回复（onError → 该轮 status=error），模型没有自我纠正的机会；转 result 后错误进入
 * 对话流，模型可据错误信息（如 resolveChapterRef 的章节清单）换参重试。
 */
async function runTool<T>(fn: () => Promise<T> | T): Promise<T | { error: string }> {
  try {
    return await fn();
  } catch (err) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** 当前书的只读阅读工具集（设计文档 §8）；全部在 main 执行，喂 streamText({ tools })。 */
export function createReadingTools(deps: ReadingToolsDeps) {
  const { db, bookId, loadBytes } = deps;

  const base = {
    getToc: tool({
      description:
        "List the book's chapters with their ids and titles. Use the returned `id` field as the chapterId for readChapterText and getChapterSummary.",
      inputSchema: z.object({}),
      execute: async () => listChapters(db, bookId),
    }),
    getChapterSummary: tool({
      description:
        "Get the cached AI summary (and its status) of a chapter by its id (from getToc).",
      inputSchema: z.object({ chapterId: z.string().min(1) }),
      execute: async ({ chapterId }) =>
        runTool(() => getChapterSummaryView(db, bookId, resolveChapterRef(db, bookId, chapterId))),
    }),
    readChapterText: tool({
      description:
        "Read the verbatim text of a chapter (id from getToc), paginated by character offset; returns { text, hasMore, nextOffset }.",
      inputSchema: z.object({
        chapterId: z.string().min(1),
        offset: z.number().int().nonnegative().optional(),
        maxChars: z.number().int().positive().optional(),
      }),
      execute: async ({ chapterId, offset, maxChars }) =>
        runTool(async () => {
          const id = resolveChapterRef(db, bookId, chapterId);
          const bytes = await loadBytes(bookId);
          return await readChapterText(db, bytes, bookId, id, { offset, maxChars });
        }),
    }),
  };

  const book = getBook(db, bookId);
  if (book?.format !== "pdf") return base;

  const pageCount = book.pageCount ?? 0;
  const hasTextLayer = Boolean(book.hasTextLayer);
  const imageOk = deps.imageToolResults ?? false;
  // 运行时按门控收窄 enum；类型断言为全集使 execute 的 mode 覆盖两种值。
  // spec §7：不支持图像 tool result 的 provider 不在 schema 中声明 image，避免模型调用后失败。
  const modes = (imageOk ? ["text", "image"] : ["text"]) as ["text", "image"];

  return {
    ...base,
    readPage: tool({
      description: imageOk
        ? 'Read one page of this PDF by 1-based page number. mode "text" returns the page text; mode "image" returns a rendered image of the page — use it for figures, tables, complex layouts, or scanned pages.'
        : "Read one page of this PDF by 1-based page number, returning the page text.",
      inputSchema: z.object({
        page: z.number().int().min(1),
        mode: z.enum(modes).default("text"),
      }),
      execute: async ({ page, mode }) =>
        runTool(async () => {
          if (page > pageCount) {
            throw new Error(`page ${page} is out of range (this book has ${pageCount} pages)`);
          }
          const bytes = await loadBytes(bookId);
          if (mode === "image") {
            const png = await renderPageImage(bytes, page, { targetWidth: READ_PAGE_IMAGE_WIDTH });
            return { kind: "image" as const, page, data: Buffer.from(png).toString("base64") };
          }
          if (!hasTextLayer) {
            throw new Error(
              `this PDF is scanned and has no text layer; text extraction is unavailable${
                imageOk ? ' — use mode "image" instead' : ""
              }`,
            );
          }
          const slice = await extractPdfText(bytes, { startPage: page, endPage: page });
          return { kind: "text" as const, page, text: slice.text };
        }),
      // 图像必须以 content part 回传模型（默认 JSON 序列化只会把 base64 变成一坨文本）；
      // text 维持 JSON 形状；runTool 的 { error } 形状原样 JSON 透传。
      toModelOutput: ({ output }) =>
        "kind" in output && output.kind === "image"
          ? {
              type: "content" as const,
              value: [{ type: "file-data" as const, mediaType: "image/png", data: output.data }],
            }
          : {
              type: "json" as const,
              value: "kind" in output ? { page: output.page, text: output.text } : output,
            },
    }),
  };
}
