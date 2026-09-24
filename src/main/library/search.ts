import { sectionTextFlow, spineHrefs, type SectionTextFlow } from "@marginalia/epub-parser";
import { openPdf, pageTextFlow } from "@marginalia/pdf-parser";
import type { DB } from "@main/db/client";
import { getBook } from "@main/library/repository";
import { listChapters } from "@main/library/content";
import type { ChapterRefDto } from "@shared/library";
import { MAX_SEARCH_HITS, type BookSearchHit, type BookSearchResult } from "@shared/search";
import {
  buildSearchIndex,
  findInIndex,
  snippetAround,
  type SearchIndex,
  type SearchableText,
} from "@shared/text-search";

/**
 * 书内搜索（spec 2026-09-24 in-book-search）：主进程负责「在哪命中」——构建文本流、匹配、归章、
 * 取片段；渲染层只负责把命中锚回 DOM。
 */

interface PdfPageFlow {
  page: number;
  text: string;
  breaks: number[];
}

export type SearchCorpus =
  | { format: "epub"; sections: SectionTextFlow[] }
  | { format: "pdf"; pages: PdfPageFlow[] };

/** 每个文本流附带预建的搜索索引：规整与查询无关，建一次、每次查询只剩 indexOf。 */
type Indexed<T> = T & { index: SearchIndex };
export type IndexedCorpus =
  | { format: "epub"; sections: Indexed<SectionTextFlow>[] }
  | { format: "pdf"; pages: Indexed<PdfPageFlow>[] };

const withIndex = <T extends SearchableText>(flow: T): Indexed<T> => ({
  ...flow,
  index: buildSearchIndex(flow),
});

/** 一次性为整份语料建索引（同步；主进程的构建走 buildCorpus 逐章让出事件循环）。 */
export function indexCorpus(corpus: SearchCorpus): IndexedCorpus {
  return corpus.format === "epub"
    ? { format: "epub", sections: corpus.sections.map(withIndex) }
    : { format: "pdf", pages: corpus.pages.map(withIndex) };
}

const SNIPPET_RADIUS = { before: 30, after: 60 };

/** 在已构建的文本流上搜索（纯函数）。命中按阅读顺序，至多 limit 条。 */
export function searchCorpus(
  corpus: IndexedCorpus,
  chapters: ChapterRefDto[],
  query: string,
  limit = MAX_SEARCH_HITS,
): { hits: BookSearchHit[]; truncated: boolean } {
  const hits: BookSearchHit[] = [];
  const collect = (
    source: Indexed<SearchableText>,
    toHit: (match: { start: number; end: number }, occurrence: number) => BookSearchHit,
  ): boolean => {
    const remaining = limit - hits.length;
    const matches = findInIndex(source.index, query, remaining + 1);
    matches.slice(0, remaining).forEach((m, k) => hits.push(toHit(m, k)));
    return matches.length > remaining;
  };
  const snippet = (source: SearchableText, m: { start: number; end: number }) =>
    snippetAround(source, m, SNIPPET_RADIUS);

  if (corpus.format === "epub") {
    const markers = epubChapterMarkers(corpus.sections, chapters);
    // 孤儿 spine 文件（无目录项）沿用前一文件最后一章——与 extractChapterAcrossSpine 的归章语义一致。
    let carried: ChapterRefDto | null = null;
    for (const section of corpus.sections) {
      const own = markers.get(section.href) ?? [];
      const chapterAt = (offset: number) =>
        own.filter((mk) => mk.offset <= offset).at(-1)?.chapter ?? carried;
      const truncated = collect(section, (m, occurrence) => {
        const ch = chapterAt(m.start);
        return {
          chapterId: ch?.id ?? null,
          chapterTitle: ch?.title ?? null,
          snippet: snippet(section, m),
          target: { format: "epub", href: section.href, occurrence },
        };
      });
      if (truncated) return { hits, truncated: true };
      carried = own.at(-1)?.chapter ?? carried;
    }
    return { hits, truncated: false };
  }

  const byStart = chapters
    .filter((c) => c.startPage != null)
    .sort((a, b) => a.startPage! - b.startPage! || a.orderIndex - b.orderIndex);
  for (const page of corpus.pages) {
    const ch = byStart.filter((c) => c.startPage! <= page.page).at(-1) ?? null;
    const truncated = collect(page, (m) => ({
      chapterId: ch?.id ?? null,
      chapterTitle: ch?.title ?? null,
      snippet: snippet(page, m),
      target: { format: "pdf", page: page.page, start: m.start, end: m.end },
    }));
    if (truncated) return { hits, truncated: true };
  }
  return { hits, truncated: false };
}

/** 每个 spine 文件内的章节起点（锚点章取锚点元素的文本流偏移，无锚点章为 0），按偏移升序。 */
function epubChapterMarkers(
  sections: SectionTextFlow[],
  chapters: ChapterRefDto[],
): Map<string, Array<{ offset: number; chapter: ChapterRefDto }>> {
  const byHref = new Map(sections.map((s) => [s.href, s]));
  const markers = new Map<string, Array<{ offset: number; chapter: ChapterRefDto }>>();
  for (const chapter of [...chapters].sort((a, b) => a.orderIndex - b.orderIndex)) {
    const section = byHref.get(chapter.href);
    if (!section) continue;
    const offset = chapter.anchor ? (section.anchors[chapter.anchor] ?? 0) : 0;
    const list = markers.get(chapter.href) ?? [];
    list.push({ offset, chapter });
    markers.set(chapter.href, list);
  }
  for (const list of markers.values()) list.sort((a, b) => a.offset - b.offset);
  return markers;
}

/** 让出一次事件循环：构建大书的索引要几百毫秒，逐章让出才不会饿死其他 IPC（如流式 AI 回复）。 */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

async function buildCorpus(format: "epub" | "pdf", bytes: Uint8Array): Promise<IndexedCorpus> {
  if (format === "epub") {
    // 逐个 spine 文件解压 + 解析 + 建索引：只碰正文 XHTML（图片等大资源不解压）。
    const sections: Indexed<SectionTextFlow>[] = [];
    for (const href of spineHrefs(bytes)) {
      const flow = sectionTextFlow(bytes, href);
      if (flow) sections.push(withIndex(flow));
      await yieldToEventLoop();
    }
    return { format, sections };
  }
  const doc = await openPdf(bytes);
  try {
    const pages: Indexed<PdfPageFlow>[] = [];
    for (let page = 1; page <= doc.numPages; page++) {
      pages.push(withIndex({ page, ...(await pageTextFlow(doc, page)) }));
      await yieldToEventLoop();
    }
    return { format, pages };
  } finally {
    await doc.loadingTask.destroy();
  }
}

interface BookSearchIndex {
  corpus: IndexedCorpus;
  /** 章节列表随索引缓存：listChapters 是逐条目录项查库（大书上约 20ms），不必每次查询都取。 */
  chapters: ChapterRefDto[];
}

type BookRow = NonNullable<ReturnType<typeof getBook>>;

// book id 是内容哈希，同一 id 的字节不变；但重建索引（parserVersion 升级）会换掉章节 id，故键里带上版本。
// 只留最近 2 本（在读的书 + 刚切走的一本）。
const INDEX_CACHE_SIZE = 2;
const indexCache = new Map<string, Promise<BookSearchIndex>>();

function cachedIndex(
  db: DB,
  book: BookRow,
  loadBytes: () => Promise<Uint8Array>,
): Promise<BookSearchIndex> {
  const key = `${book.id}:${book.parserVersion ?? 0}`;
  const hit = indexCache.get(key);
  if (hit) {
    indexCache.delete(key);
    indexCache.set(key, hit);
    return hit;
  }
  const built = loadBytes().then(async (bytes) => ({
    corpus: await buildCorpus(book.format, bytes),
    chapters: listChapters(db, book.id),
  }));
  indexCache.set(key, built);
  built.catch(() => indexCache.delete(key)); // 失败不缓存，下次重试
  while (indexCache.size > INDEX_CACHE_SIZE) {
    indexCache.delete(indexCache.keys().next().value!);
  }
  return built;
}

/**
 * 预热：用户打开搜索页时提前建索引，等输入完第一个词时通常已就绪。
 * 扫描版 PDF 无可建之物，直接跳过。
 */
export async function prepareBookSearch(
  db: DB,
  bookId: string,
  loadBytes: () => Promise<Uint8Array>,
): Promise<void> {
  const book = getBook(db, bookId);
  if (!book) throw new Error(`search: book ${bookId} not found`);
  if (book.format === "pdf" && !book.hasTextLayer) return;
  await cachedIndex(db, book, loadBytes);
}

export async function searchBook(
  db: DB,
  bookId: string,
  query: string,
  loadBytes: () => Promise<Uint8Array>,
): Promise<BookSearchResult> {
  const book = getBook(db, bookId);
  if (!book) throw new Error(`search: book ${bookId} not found`);
  if (book.format === "pdf" && !book.hasTextLayer) return { kind: "no-text-layer" };
  const { corpus, chapters } = await cachedIndex(db, book, loadBytes);
  return { kind: "ok", ...searchCorpus(corpus, chapters, query) };
}
