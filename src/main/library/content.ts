import { and, asc, eq } from "drizzle-orm";
import { extractBookText, extractChapterText, type ReadOptions } from "@marginalia/epub-parser";
import { extractPdfText } from "@marginalia/pdf-parser";
import type { DB } from "@main/db/client";
import { books, chapters } from "@main/db/schema";
import { getBook, resolveChapterByHref } from "@main/library/repository";
import { tocNodeSchema, type TocNode } from "@shared/types";
import type { ChapterRefDto, ChapterTextSlice } from "@shared/library";
import { t } from "@main/i18n";

export function getToc(db: DB, bookId: string): TocNode[] {
  const row = db.select({ toc: books.toc }).from(books).where(eq(books.id, bookId)).get();
  // parse-on-read：DB JSON 列做一次 Zod 校验（防 JSON 漂移）
  // Because tocNodeSchema is recursive, a node whose *any* descendant fails validation causes the
  // entire top-level entry to be dropped — intentional defensive degradation for now; surgical
  // subtree pruning is a future follow-up.
  return (row?.toc ?? []).filter((n) => tocNodeSchema.safeParse(n).success);
}

export async function readChapterText(
  db: DB,
  bytes: Uint8Array,
  bookId: string,
  chapterId: string,
  opts: ReadOptions,
): Promise<ChapterTextSlice> {
  const book = getBook(db, bookId);
  if (!book) throw new Error(`content: book ${bookId} not found`);
  const ch = db
    .select({ href: chapters.href, startPage: chapters.startPage, endPage: chapters.endPage })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
  if (!ch) throw new Error(`content: chapter ${chapterId} not found in book ${bookId}`);
  if (book.format === "pdf") {
    // 扫描版防御（spec §8）：绝不静默返回空文本——模型/调用方必须收到真实原因。
    if (!book.hasTextLayer) {
      throw new Error(t("errors.noTextLayer", "扫描版 PDF 没有文本层，无法提取文本"));
    }
    return extractPdfText(bytes, {
      startPage: ch.startPage ?? 1,
      endPage: ch.endPage ?? book.pageCount ?? 1,
      offset: opts.offset,
      maxChars: opts.maxChars,
    });
  }
  return extractChapterText(bytes, ch.href, opts);
}

/**
 * 取全书正文：按 spine 顺序（orderIndex）拼接所有章节正文，累计到 `maxChars` 截断。
 * 供全书摘要一次性喂模型（用户决策「直接喂整本书」）。委托 `extractBookText`——**只解压一次**
 * （逐章 extractChapterText 会每次全解压 epub，N 章 = N 次、同步阻塞主进程，导致重新生成时 app 卡死）。
 */
export async function readBookText(
  db: DB,
  bytes: Uint8Array,
  bookId: string,
  opts: { maxChars: number },
): Promise<{ text: string; truncated: boolean }> {
  const book = getBook(db, bookId);
  if (!book) throw new Error(`content: book ${bookId} not found`);
  if (book.format === "pdf") {
    // 扫描版防御（spec §8）：绝不静默返回空文本——模型/调用方必须收到真实原因。
    if (!book.hasTextLayer) {
      throw new Error(t("errors.noTextLayer", "扫描版 PDF 没有文本层，无法提取文本"));
    }
    const slice = await extractPdfText(bytes, {
      startPage: 1,
      endPage: book.pageCount ?? 1,
      maxChars: opts.maxChars,
    });
    return { text: slice.text, truncated: slice.hasMore };
  }
  const hrefs = db
    .select({ href: chapters.href })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.orderIndex))
    .all()
    .map((r) => r.href);
  return extractBookText(bytes, hrefs, opts);
}

/**
 * 扫描版门控（spec §8 主进程防御层）：无文本层的书绝不静默生成空摘要。
 */
export function assertTextLayer(db: DB, bookId: string): void {
  const book = getBook(db, bookId);
  // 缺书也要抛：静默通过会让后续 fire-and-forget ensure* 把 not-found 吞进 console.warn，
  // 渲染层收不到任何 reject，摘要永远卡 pending。
  if (!book) throw new Error(`content: book ${bookId} not found`);
  if (!book.hasTextLayer) {
    throw new Error(t("errors.noTextLayer", "扫描版 PDF 没有文本层，无法提取文本"));
  }
}

/**
 * 列出用于导航的「章节」——**以 TOC 为准**：章节是目录里有标题的条目，而非 spine 文档本身。
 * spine 含封面/版权/分隔等非正文页，它们不在 TOC、无标题，不应算章节（spec §7.2 / 8.1 设计）。
 * 嵌套 TOC（章→节）以 `level` 表达（0=章，1+=节）。多个 TOC 条目指向同一 spine 文件（带锚点的小节）
 * 因当前无锚定能力（RA1-full）按 spine 文件去重、仅保留首个。
 * 兜底：epub 无可用 TOC（罕见，畸形书）时退回 spine 顺序编号（title 缺失 → UI 渲染为「第 N 章」）。
 */
export function listChapters(db: DB, bookId: string): ChapterRefDto[] {
  const out: ChapterRefDto[] = [];
  const seen = new Set<string>();
  const walk = (nodes: TocNode[], level: number): void => {
    for (const n of nodes) {
      if (n.href && n.label) {
        const ch = resolveChapterByHref(db, bookId, n.href);
        if (ch && !seen.has(ch.id)) {
          seen.add(ch.id);
          out.push({
            id: ch.id,
            title: n.label,
            href: ch.href,
            orderIndex: ch.orderIndex ?? 0,
            level,
            startPage: ch.startPage ?? null,
            endPage: ch.endPage ?? null,
          });
        }
      }
      if (n.children) walk(n.children, level + 1);
    }
  };
  walk(getToc(db, bookId), 0);
  if (out.length > 0) return out;

  // 无 TOC 兜底：spine 顺序，标题缺失。
  return db
    .select({
      id: chapters.id,
      title: chapters.title,
      href: chapters.href,
      orderIndex: chapters.orderIndex,
      startPage: chapters.startPage,
      endPage: chapters.endPage,
    })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.orderIndex))
    .all()
    .map((c) => ({
      id: c.id,
      title: c.title,
      href: c.href,
      orderIndex: c.orderIndex ?? 0,
      level: 0,
      startPage: c.startPage ?? null,
      endPage: c.endPage ?? null,
    }));
}
