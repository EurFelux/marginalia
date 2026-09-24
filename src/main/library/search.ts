import { sectionTextFlows, type SectionTextFlow } from "@marginalia/epub-parser";
import { openPdf, pageTextFlow } from "@marginalia/pdf-parser";
import type { DB } from "@main/db/client";
import { getBook } from "@main/library/repository";
import { listChapters } from "@main/library/content";
import type { ChapterRefDto } from "@shared/library";
import { MAX_SEARCH_HITS, type BookSearchHit, type BookSearchResult } from "@shared/search";
import { findMatches, snippetAround, type SearchableText } from "@shared/text-search";

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

const SNIPPET_RADIUS = { before: 30, after: 60 };

/** 在已构建的文本流上搜索（纯函数）。命中按阅读顺序，至多 limit 条。 */
export function searchCorpus(
  corpus: SearchCorpus,
  chapters: ChapterRefDto[],
  query: string,
  limit = MAX_SEARCH_HITS,
): { hits: BookSearchHit[]; truncated: boolean } {
  const hits: BookSearchHit[] = [];
  const collect = (
    source: SearchableText,
    toHit: (match: { start: number; end: number }, occurrence: number) => BookSearchHit,
  ): boolean => {
    const remaining = limit - hits.length;
    const matches = findMatches(source, query, remaining + 1);
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

async function buildCorpus(format: "epub" | "pdf", bytes: Uint8Array): Promise<SearchCorpus> {
  if (format === "epub") return { format, sections: sectionTextFlows(bytes) };
  const doc = await openPdf(bytes);
  try {
    const pages: PdfPageFlow[] = [];
    for (let page = 1; page <= doc.numPages; page++) {
      pages.push({ page, ...(await pageTextFlow(doc, page)) });
    }
    return { format, pages };
  } finally {
    await doc.loadingTask.destroy();
  }
}

// book id 是内容哈希：同一 id 的字节不变，缓存无需失效。只留最近 2 本（在读的书 + 刚切走的一本）。
const CORPUS_CACHE_SIZE = 2;
const corpusCache = new Map<string, Promise<SearchCorpus>>();

function cachedCorpus(
  bookId: string,
  format: "epub" | "pdf",
  loadBytes: () => Promise<Uint8Array>,
): Promise<SearchCorpus> {
  const hit = corpusCache.get(bookId);
  if (hit) {
    corpusCache.delete(bookId);
    corpusCache.set(bookId, hit);
    return hit;
  }
  const built = loadBytes().then((bytes) => buildCorpus(format, bytes));
  corpusCache.set(bookId, built);
  built.catch(() => corpusCache.delete(bookId)); // 失败不缓存，下次重试
  while (corpusCache.size > CORPUS_CACHE_SIZE) {
    corpusCache.delete(corpusCache.keys().next().value!);
  }
  return built;
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
  const corpus = await cachedCorpus(bookId, book.format, loadBytes);
  return { kind: "ok", ...searchCorpus(corpus, listChapters(db, bookId), query) };
}
