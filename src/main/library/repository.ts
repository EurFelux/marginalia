import { createHash } from "node:crypto";
import { and, asc, desc, eq, isNull, sql } from "drizzle-orm";
import { parseEpub, type TocNode } from "@marginalia/epub-parser";
import { parsePdf, renderPageImage } from "@marginalia/pdf-parser";
import type { DB } from "@main/db/client";
import { books, chapters, progress } from "@main/db/schema";
import { deleteBookFile } from "@main/library/book-files";
import { createLogger } from "@main/logger";

const log = createLogger("library");

/** 解析器/索引结构版本。结构变更（如锚点级章节）时 +1，触发存量书惰性重建。 */
export const CURRENT_PARSER_VERSION = 1;

interface ChapterSeed {
  href: string;
  anchor: string | null;
  title: string | null;
}

/** 扁平化 TOC（DFS 保序）为章节种子；按 (href, anchor) 去重保首个（防 TOC 重复条目撞唯一约束）。 */
function chapterSeedsFromToc(toc: TocNode[]): ChapterSeed[] {
  const seeds: ChapterSeed[] = [];
  const seen = new Set<string>();
  const walk = (nodes: TocNode[]): void => {
    for (const n of nodes) {
      const anchor = n.anchor ?? null;
      const key = `${n.href}|${anchor ?? ""}`;
      if (n.href && !seen.has(key)) {
        seen.add(key);
        seeds.push({ href: n.href, anchor, title: n.label || null });
      }
      if (n.children) walk(n.children);
    }
  };
  walk(toc);
  return seeds;
}

/** 章节种子：优先 TOC 条目（锚点级）；无 TOC 退回 spine 文件顺序（anchor=null, title=null）。 */
function chapterSeedsFor(parsed: { toc: TocNode[]; spine: { href: string }[] }): ChapterSeed[] {
  const fromToc = chapterSeedsFromToc(parsed.toc);
  if (fromToc.length > 0) return fromToc;
  return parsed.spine.map((s) => ({ href: s.href, anchor: null, title: null }));
}

export interface ImportInput {
  bytes: Uint8Array;
  /** 原始文件名（不含路径）。PDF 元数据缺 Title 时回退为书名（去扩展名）。 */
  fileName?: string;
}
export type BookRow = typeof books.$inferSelect;
export type ChapterRow = typeof chapters.$inferSelect;

/** 魔数嗅探（不信文件后缀）：%PDF- → pdf；PK（zip 头）→ epub；其余诚实报错。 */
export function detectFormat(bytes: Uint8Array): "epub" | "pdf" {
  if (
    bytes[0] === 0x25 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x44 &&
    bytes[3] === 0x46 &&
    bytes[4] === 0x2d
  ) {
    return "pdf";
  }
  if (bytes[0] === 0x50 && bytes[1] === 0x4b) return "epub";
  throw new Error("not a supported book format (expected ePub or PDF)");
}

export async function importBook(db: DB, input: ImportInput): Promise<BookRow> {
  return detectFormat(input.bytes) === "pdf"
    ? importPdfBook(db, input.bytes, input.fileName)
    : importEpubBook(db, input.bytes);
}

/** 原 importBook 函数体原样改名为 importEpubBook（保持同步实现；async 包装由 importBook 承担）。 */
function importEpubBook(db: DB, bytes: Uint8Array): BookRow {
  const parsed = parseEpub(bytes);
  // 身份＝内容哈希（与 PDF 一致）。epub 的 dc:identifier 现实中并不唯一——z-library 等转换源会给
  // 不同的书盖同一个写死的 boilerplate uid，若用它当主键，第二本会撞主键被误判「已存在」而丢失。
  const id = createHash("sha256").update(bytes).digest("hex");

  // 幂等：同字节流（即同一文件重导）已在库则直接返回，不写入 books/chapters（零 DB churn）。
  // "显式刷新/重新导入"留后续里程碑（按 (book_id, href) 稳定 upsert 保 chapter id）。
  const existing = db.select().from(books).where(eq(books.id, id)).get();
  if (existing) return existing;

  return db.transaction((tx) => {
    tx.insert(books)
      .values({
        id,
        title: parsed.title ?? null,
        author: parsed.author ?? null,
        cover: parsed.cover ? Buffer.from(parsed.cover) : null,
        toc: parsed.toc,
        // 新导入排最前（spec §3）：自引用标量子查询，空库 coalesce(NULL,1)-1 = 0。
        position: sql`(coalesce((select min(position) from books), 1) - 1)`,
        parserVersion: CURRENT_PARSER_VERSION,
      })
      .run();

    chapterSeedsFor(parsed).forEach((seed, index) => {
      tx.insert(chapters)
        .values({
          bookId: id,
          href: seed.href,
          anchor: seed.anchor,
          orderIndex: index,
          title: seed.title,
        })
        .run();
    });

    const row = tx.select().from(books).where(eq(books.id, id)).get();
    if (!row) throw new Error("importEpubBook: book row missing after insert");
    return row;
  });
}

async function importPdfBook(db: DB, bytes: Uint8Array, fileName?: string): Promise<BookRow> {
  const parsed = await parsePdf(bytes);
  const id = createHash("sha256").update(bytes).digest("hex"); // PDF 无自然键，统一文件哈希

  const existing = db.select().from(books).where(eq(books.id, id)).get();
  if (existing) return existing;

  // 封面 = 首页缩略图；渲染失败不阻塞导入（书库走兜底 tile）。
  const cover = await renderPageImage(bytes, 1, { targetWidth: 600 }).catch((err: unknown) => {
    log.warn("pdf cover render failed", err);
    return null;
  });

  // PDF 元数据缺 Title 时回退文件名（去扩展名）；trim 后为空串视同缺失。
  const fallbackTitle = fileName?.replace(/\.[^.]+$/, "").trim() || undefined;
  const title = parsed.title ?? fallbackTitle ?? null;

  return db.transaction((tx) => {
    tx.insert(books)
      .values({
        id,
        title,
        author: parsed.author ?? null,
        cover: cover ? Buffer.from(cover) : null,
        toc: parsed.toc,
        format: "pdf",
        pageCount: parsed.pageCount,
        hasTextLayer: parsed.hasTextLayer,
        // 新导入排最前（spec §3）：自引用标量子查询，空库 coalesce(NULL,1)-1 = 0。
        position: sql`(coalesce((select min(position) from books), 1) - 1)`,
        parserVersion: CURRENT_PARSER_VERSION,
      })
      .run();

    parsed.chapterRanges.forEach((range, index) => {
      tx.insert(chapters)
        .values({
          bookId: id,
          href: `pdf-ch:${index}`,
          orderIndex: index,
          // 有 outline：toc 同序号的 label；单章退化：取书名（spec §2——避免 title:null 困惑模型）
          title: parsed.toc[index]?.label ?? title,
          startPage: range.startPage,
          endPage: range.endPage,
        })
        .run();
    });

    const row = tx.select().from(books).where(eq(books.id, id)).get();
    if (!row) throw new Error("importPdfBook: book row missing after insert");
    return row;
  });
}

/** 「继续阅读」shelf 容量（spec §4）。 */
export const RECENT_SHELF_LIMIT = 3;

export function listBooks(db: DB) {
  return db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      hasCover: sql<boolean>`${books.cover} is not null and length(${books.cover}) > 0`,
      format: books.format,
      pageCount: books.pageCount,
      hasTextLayer: books.hasTextLayer,
    })
    .from(books)
    .orderBy(asc(books.position), asc(books.addedAt))
    .all();
}

/**
 * 「继续阅读」shelf 数据（#48）：JOIN progress 按最近阅读排序。未读过的书（无 progress 行）
 * 天然不出现；percent 为 null（老数据）由渲染层降级。不解析 locator——黑盒保持。
 */
export function listRecentlyRead(db: DB, limit = RECENT_SHELF_LIMIT) {
  return db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      hasCover: sql<boolean>`${books.cover} is not null and length(${books.cover}) > 0`,
      format: books.format,
      pageCount: books.pageCount,
      hasTextLayer: books.hasTextLayer,
      percent: progress.percent,
      lastReadAt: progress.updatedAt,
    })
    .from(books)
    .innerJoin(progress, eq(progress.bookId, books.id))
    .orderBy(desc(progress.updatedAt))
    .limit(limit)
    .all();
}

/** 手动排序全量重写（#48）：position = orderedIds 下标。未知 id 的 UPDATE 是 no-op，无害。 */
export function reorderBooks(db: DB, orderedIds: string[]): void {
  db.transaction((tx) => {
    orderedIds.forEach((id, index) => {
      tx.update(books).set({ position: index }).where(eq(books.id, id)).run();
    });
  });
}
export function getBook(db: DB, id: string): BookRow | undefined {
  return db.select().from(books).where(eq(books.id, id)).get();
}

/**
 * 更新书名/作者（#29）。put 语义：author=null 显式清空。
 * 注：导入幂等是 early return（见 importBook），重导同一文件不会触碰已有行——手动修改不会被解析元数据冲掉。
 */
export function updateBook(
  db: DB,
  input: { bookId: string; title: string; author: string | null },
): BookRow {
  const row = db
    .update(books)
    .set({ title: input.title, author: input.author })
    .where(eq(books.id, input.bookId))
    .returning()
    .get();
  if (!row) throw new Error(`library: book ${input.bookId} not found`);
  return row;
}
export function resolveChapterByHref(db: DB, bookId: string, href: string): ChapterRow | undefined {
  return db
    .select()
    .from(chapters)
    .where(and(eq(chapters.bookId, bookId), eq(chapters.href, href)))
    .get();
}

/** 按 (href, anchor) 精确解析章节行；anchor 为 null 时匹配 anchor IS NULL 行。 */
export function resolveChapter(
  db: DB,
  bookId: string,
  href: string,
  anchor: string | null,
): ChapterRow | undefined {
  return db
    .select()
    .from(chapters)
    .where(
      and(
        eq(chapters.bookId, bookId),
        eq(chapters.href, href),
        anchor === null ? isNull(chapters.anchor) : eq(chapters.anchor, anchor),
      ),
    )
    .get();
}

/**
 * 删书：先删 DB 行（真相源；依赖行靠 FK ON DELETE CASCADE 自动清，P3a），再 best-effort 删自有副本文件。
 * 顺序不可反——指向已删文件的 DB 行 = 打不开的鬼书，比无主文件（可 GC）更糟（DD-§1.3）。
 * 幂等：删不存在的书是 no-op（DELETE 命中 0 行；行不存在读不到 format 则直接跳过 unlink），不抛——契合删书 UI 的重复点击 / 乐观删除竞态。
 */
export async function deleteBook(db: DB, booksDir: string, bookId: string): Promise<void> {
  const book = getBook(db, bookId); // 删行前取 format（行删后取不到）
  db.delete(books).where(eq(books.id, bookId)).run();
  if (book) await deleteBookFile(booksDir, bookId, book.format);
}
