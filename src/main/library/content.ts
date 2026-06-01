import { and, asc, eq } from "drizzle-orm";
import { extractChapterText, type ReadOptions } from "@marginalia/epub-parser";
import type { DB } from "@main/db/client";
import { books, chapters } from "@main/db/schema";
import { resolveChapterByHref } from "@main/library/repository";
import { tocNodeSchema, type TocNode } from "@shared/types";
import type { ChapterRefDto, ChapterTextSlice } from "@shared/library";

export interface ChapterSummary {
  status: "pending" | "generating" | "ready" | "unavailable";
  summary: string | null;
}

export function getToc(db: DB, bookId: string): TocNode[] {
  const row = db.select({ toc: books.toc }).from(books).where(eq(books.id, bookId)).get();
  // parse-on-read：DB JSON 列做一次 Zod 校验（防 JSON 漂移）
  // Because tocNodeSchema is recursive, a node whose *any* descendant fails validation causes the
  // entire top-level entry to be dropped — intentional defensive degradation for now; surgical
  // subtree pruning is a future follow-up.
  return (row?.toc ?? []).filter((n) => tocNodeSchema.safeParse(n).success);
}

export function getChapterSummary(db: DB, bookId: string, chapterId: string): ChapterSummary {
  const row = db
    .select({ summary: chapters.summary, status: chapters.summaryStatus })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
  if (!row) throw new Error(`content: chapter ${chapterId} not found in book ${bookId}`);
  return { status: row.status, summary: row.summary ?? null };
}

export function readChapterText(
  db: DB,
  bytes: Uint8Array,
  bookId: string,
  chapterId: string,
  opts: ReadOptions,
): ChapterTextSlice {
  const ch = db
    .select({ href: chapters.href })
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.id, chapterId)))
    .get();
  if (!ch) throw new Error(`content: chapter ${chapterId} not found in book ${bookId}`);
  return extractChapterText(bytes, ch.href, opts);
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
    }));
}
