import { and, asc, eq } from "drizzle-orm";
import {
  extractBookText,
  extractChapterAcrossSpine,
  type ReadOptions,
} from "@marginalia/epub-parser";
import { extractPdfText } from "@marginalia/pdf-parser";
import type { DB } from "@main/db/client";
import { books, chapters } from "@main/db/schema";
import { getBook, resolveChapter } from "@main/library/repository";
import { tocNodeSchema, type TocNode } from "@shared/types";
import type { ChapterRefDto, ChapterTextSlice } from "@shared/library";
import { t } from "@main/i18n";
import { createLogger } from "@main/logger";

const log = createLogger("library");

export function getToc(db: DB, bookId: string): TocNode[] {
  const row = db.select({ toc: books.toc }).from(books).where(eq(books.id, bookId)).get();
  // parse-on-read：DB JSON 列做一次 Zod 校验（防 JSON 漂移）
  // Because tocNodeSchema is recursive, a node whose *any* descendant fails validation causes the
  // entire top-level entry to be dropped — intentional defensive degradation for now; surgical
  // subtree pruning is a future follow-up.
  return (row?.toc ?? []).filter((n) => {
    const result = tocNodeSchema.safeParse(n);
    if (!result.success) {
      const firstPath = result.error.issues[0]?.path.join(".") ?? "(unknown)";
      log.warn(`toc node failed validation, skipped (book ${bookId}): ${firstPath}`);
    }
    return result.success;
  });
}

export interface EpubChapterSpan {
  /** 本章起点（目录项的 href + 可选锚点）。 */
  start: { href: string; anchor?: string };
  /** 本章终点 = 下一目录项的起点（之前为止）；undefined = 读到书末。 */
  end: { href: string; anchor?: string } | undefined;
}

/**
 * 全书的 ePub 章节区间（readChapterText 与 AI 搜索语料共用此单一边界来源，保证两侧语义一致）：
 * 本章正文 = 从本章 (href, anchor) 起，到「下一目录项」(阅读顺序 = orderIndex 递增) 的 (href, anchor)
 * 之前，按 spine 顺序跨文件拼接。下一目录项可能在另一个 spine 文件，中间没有独立目录项的孤儿
 * spine 文件（如《七个习惯》第二章正文所在的 split 文件）由 extractChapterAcrossSpine 归入本章——
 * 单 href 抽取会把它们整段漏掉。末章（无下一项）读到全书末尾。
 */
export function listEpubChapterSpans(db: DB, bookId: string): Map<string, EpubChapterSpan> {
  const rows = db
    .select({
      id: chapters.id,
      href: chapters.href,
      anchor: chapters.anchor,
      orderIndex: chapters.orderIndex,
    })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.orderIndex))
    .all();
  const spans = new Map<string, EpubChapterSpan>();
  for (let i = 0; i < rows.length; i++) {
    const ch = rows[i]!;
    let end: EpubChapterSpan["end"];
    if (ch.orderIndex != null) {
      // 「下一目录项」= orderIndex 严格更大的第一行（null 不参与比较；升序排列下 null 只出现在
      // 非空值之前，从 i+1 扫到的非空行必然 orderIndex >= 本行，取第一个严格更大者即等价原 gt 查询）。
      const next = rows
        .slice(i + 1)
        .find((r) => r.orderIndex != null && r.orderIndex > ch.orderIndex!);
      if (next) end = { href: next.href, anchor: next.anchor ?? undefined };
    }
    spans.set(ch.id, { start: { href: ch.href, anchor: ch.anchor ?? undefined }, end });
  }
  return spans;
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
    .select({
      startPage: chapters.startPage,
      endPage: chapters.endPage,
    })
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
  const span = listEpubChapterSpans(db, bookId).get(chapterId);
  if (!span) throw new Error(`content: chapter ${chapterId} not found in book ${bookId}`);
  return extractChapterAcrossSpine(bytes, span.start, span.end, opts);
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
  const rows = db
    .select({ href: chapters.href })
    .from(chapters)
    .where(eq(chapters.bookId, bookId))
    .orderBy(asc(chapters.orderIndex))
    .all();
  const seen = new Set<string>();
  const hrefs = rows.map((r) => r.href).filter((h) => (seen.has(h) ? false : (seen.add(h), true)));
  return extractBookText(bytes, hrefs, opts);
}

/**
 * 扫描版门控（spec §8 主进程防御层）：无文本层的书绝不静默生成空摘要。
 */
export function assertTextLayer(db: DB, bookId: string): void {
  const book = getBook(db, bookId);
  // 缺书也要抛：静默通过会让后续 fire-and-forget ensure* 把 not-found 吞进 warn 日志，
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
        const ch = resolveChapter(db, bookId, n.href, n.anchor ?? null);
        if (!ch) {
          log.warn(
            `toc entry not found in chapters (book ${bookId}, href ${n.href}, anchor ${n.anchor ?? "∅"})`,
          );
        } else if (!seen.has(ch.id)) {
          seen.add(ch.id);
          out.push({
            id: ch.id,
            title: n.label,
            href: ch.href,
            anchor: ch.anchor ?? null,
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
      anchor: chapters.anchor,
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
      anchor: c.anchor ?? null,
      orderIndex: c.orderIndex ?? 0,
      level: 0,
      startPage: c.startPage ?? null,
      endPage: c.endPage ?? null,
    }));
}
