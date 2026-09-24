import { sectionTextFlow, spineHrefs, type SectionTextFlow } from "@marginalia/epub-parser";
import { openPdf, pageTextFlow } from "@marginalia/pdf-parser";
import type { DB } from "@main/db/client";
import { getBook } from "@main/library/repository";
import { listChapters } from "@main/library/content";
import type { ChapterRefDto } from "@shared/library";
import { chapterIdAtPage } from "@shared/pdf-chapter-at-page";
import {
  MAX_SEARCH_HITS,
  type BookSearchHit,
  type BookSearchResult,
  type SearchHitTarget,
} from "@shared/search";
import {
  buildSearchIndex,
  findInIndex,
  snippetAround,
  type SearchIndex,
  type SearchableText,
  type TextMatch,
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

/** 文本流附带预建的搜索索引：规整与查询无关，建一次、每次查询只剩 indexOf。 */
type Indexed<T> = T & { index: SearchIndex };

export const withIndex = <T extends SearchableText>(flow: T): Indexed<T> => ({
  ...flow,
  index: buildSearchIndex(flow),
});

export type IndexedCorpus =
  | { format: "epub"; sections: Indexed<SectionTextFlow>[] }
  | { format: "pdf"; pages: Indexed<PdfPageFlow>[] };

/** 搜索的基本单位：一段带索引的文本流，连同它的归章与定位规则（每本书算一次，随索引缓存）。 */
export interface SearchSegment {
  source: Indexed<SearchableText>;
  chapterAt: (offset: number) => ChapterRefDto | null;
  target: (match: TextMatch, occurrence: number) => SearchHitTarget;
}

/** 语料 → 分段：ePub 一个 spine 文件一段（章节可在文件内以锚点切分），PDF 一页一段。 */
export function bookSegments(corpus: IndexedCorpus, chapters: ChapterRefDto[]): SearchSegment[] {
  if (corpus.format === "pdf") {
    return corpus.pages.map((page) => {
      // 与标注列表同一归章规则（chapterIdAtPage），两处对同一页给出同一章。
      const id = chapterIdAtPage(chapters, page.page);
      const chapter = chapters.find((c) => c.id === id) ?? null;
      return {
        source: page,
        chapterAt: () => chapter,
        target: (m) => ({ format: "pdf", page: page.page, start: m.start, end: m.end }),
      };
    });
  }
  const markers = epubChapterMarkers(corpus.sections, chapters);
  // 孤儿 spine 文件（无目录项）沿用前一文件最后一章——与 extractChapterAcrossSpine 的归章语义一致。
  let carried: ChapterRefDto | null = null;
  return corpus.sections.map((section) => {
    const own = markers.get(section.href) ?? [];
    const inherited = carried;
    carried = own.at(-1)?.chapter ?? carried;
    return {
      source: section,
      chapterAt: (offset) => own.filter((mk) => mk.offset <= offset).at(-1)?.chapter ?? inherited,
      target: (_, occurrence) => ({ format: "epub", href: section.href, occurrence }),
    };
  });
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

const SNIPPET_RADIUS = { before: 30, after: 60 };

/** 在分段上搜索（纯函数）。命中按阅读顺序，至多 limit 条。 */
export function searchSegments(
  segments: SearchSegment[],
  query: string,
  limit = MAX_SEARCH_HITS,
): { hits: BookSearchHit[]; truncated: boolean } {
  const hits: BookSearchHit[] = [];
  for (const segment of segments) {
    const remaining = limit - hits.length;
    const matches = findInIndex(segment.source.index, query, remaining + 1);
    matches.slice(0, remaining).forEach((m, occurrence) => {
      const chapter = segment.chapterAt(m.start);
      hits.push({
        chapterId: chapter?.id ?? null,
        chapterTitle: chapter?.title ?? null,
        snippet: snippetAround(segment.source, m, SNIPPET_RADIUS),
        target: segment.target(m, occurrence),
      });
    });
    if (matches.length > remaining) return { hits, truncated: true };
  }
  return { hits, truncated: false };
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

/** 按书的格式读书文件；只在索引未缓存时才会被调用。 */
export type LoadBookBytes = (format: "epub" | "pdf") => Promise<Uint8Array>;

// book id 是内容哈希，同一 id 的字节不变；但重建索引（parserVersion 升级）会换掉章节 id，故键里带上版本。
// 章节列表（listChapters 逐条目录项查库，大书上约 20ms）在建分段时取用一次、随分段缓存。
// 只留最近 2 本（在读的书 + 刚切走的一本）。
const INDEX_CACHE_SIZE = 2;
const indexCache = new Map<string, Promise<SearchSegment[]>>();

/** 取（必要时构建）这本书的搜索分段；扫描版 PDF 没有可搜索的文本。 */
function loadBookIndex(
  db: DB,
  bookId: string,
  loadBytes: LoadBookBytes,
): Promise<SearchSegment[]> | "no-text-layer" {
  const book = getBook(db, bookId);
  if (!book) throw new Error(`search: book ${bookId} not found`);
  if (book.format === "pdf" && !book.hasTextLayer) return "no-text-layer";
  const key = `${book.id}:${book.parserVersion ?? 0}`;
  const hit = indexCache.get(key);
  if (hit) {
    indexCache.delete(key);
    indexCache.set(key, hit);
    return hit;
  }
  const built = loadBytes(book.format)
    .then((bytes) => buildCorpus(book.format, bytes))
    .then((corpus) => bookSegments(corpus, listChapters(db, book.id)));
  indexCache.set(key, built);
  built.catch(() => indexCache.delete(key)); // 失败不缓存，下次重试
  while (indexCache.size > INDEX_CACHE_SIZE) {
    indexCache.delete(indexCache.keys().next().value!);
  }
  return built;
}

/** 预热：用户打开搜索页时提前建索引，等输入完第一个词时通常已就绪。 */
export async function prepareBookSearch(
  db: DB,
  bookId: string,
  loadBytes: LoadBookBytes,
): Promise<void> {
  await loadBookIndex(db, bookId, loadBytes);
}

export async function searchBook(
  db: DB,
  bookId: string,
  query: string,
  loadBytes: LoadBookBytes,
): Promise<BookSearchResult> {
  const index = loadBookIndex(db, bookId, loadBytes);
  if (index === "no-text-layer") return { kind: "no-text-layer" };
  return { kind: "ok", ...searchSegments(await index, query) };
}
