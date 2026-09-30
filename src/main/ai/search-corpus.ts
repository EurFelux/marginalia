// src/main/ai/search-corpus.ts —— AI 书内搜索语料（spec 2026-09-30-ai-search-tool-design）。
// 与 UI 搜索（src/main/library/search.ts）相互独立：这里以**章**为单位构建全文语料，
// 每章文本就是 readChapterText 分页前的那根字符串（同一构造函数：epub 走 chapterTextAcrossSpine，
// pdf 走 chapterPdfText），故命中的 chapterOffset 与 readChapterText 的 offset 坐标**逐字节对齐**，
// 模型可直接带窗口精读，无需估计。搜索覆盖因此恰好等于模型经 readChapterText 可达的内容。
import { strFromU8 } from "fflate";
import { chapterTextAcrossSpine, spineHrefs, unzipEntry } from "@marginalia/epub-parser";
import { chapterPdfText, openPdf } from "@marginalia/pdf-parser";
import type { DB } from "@main/db/client";
import { getBook } from "@main/library/repository";
import { listChapters, listEpubChapterSpans } from "@main/library/content";
import {
  buildSearchIndex,
  findInIndex,
  snippetAround,
  type SearchIndex,
  type Snippet,
} from "@shared/text-search";

/** 取某书原始字节（与 tools.ts 的 LoadBytes 同签名；独立声明避免模块环）。 */
export type LoadBookBytes = (bookId: string) => Promise<Uint8Array>;

/** 一章的搜索语料：全文 + 预建索引。text 即 readChapterText 分页前的那根字符串。 */
export interface ChapterCorpus {
  chapterId: string;
  chapterTitle: string | null;
  text: string;
  index: SearchIndex;
  /** 仅 PDF：[p.N] 页标记在 text 中的偏移（升序），命中归页用。 */
  pageMarkers?: Array<{ offset: number; page: number }>;
}

export interface CorpusHit {
  chapterId: string;
  chapterTitle: string | null;
  snippet: Snippet;
  /** 命中在章文本中的起点（readChapterText 的 offset 空间，精确）。 */
  chapterOffset: number;
  /** 仅 PDF：命中所在页（精确，配 readPage）。 */
  page?: number;
}

/** AI 工具单次返回的命中上限（spec：固定 20，超出带 truncated 引导模型换更精确的词）。 */
export const AI_SEARCH_MAX_HITS = 20;

/** snippet 半径（spec：±50 启发式常量——模型没有「点进去看」的第一跳，snippet 是判断相关性的全部依据）。 */
const SNIPPET_RADIUS = { before: 50, after: 50 };

/** 让出一次事件循环：大书逐章构建要几百毫秒，让出才不会饿死其他 IPC（如流式 AI 回复）。 */
const yieldToEventLoop = () => new Promise<void>((resolve) => setImmediate(resolve));

/**
 * 章文本里的 [p.N] 页标记偏移。页文本经 \s+ 折叠不含 "\n\n"，故 "\n\n[p.N]" 只可能是真标记
 * （首标记在 offset 0）；不可能与正文撞车。
 */
function pdfPageMarkers(text: string): Array<{ offset: number; page: number }> {
  const markers: Array<{ offset: number; page: number }> = [];
  for (const m of text.matchAll(/(?:^|\n\n)\[p\.(\d+)\]/g)) {
    markers.push({ offset: m.index + m[0].length - m[1]!.length - 4, page: Number(m[1]) });
  }
  return markers;
}

export function buildEpubCorpus(
  db: DB,
  bookId: string,
  bytes: Uint8Array,
): Promise<ChapterCorpus[]> {
  const spine = spineHrefs(bytes);
  const spans = listEpubChapterSpans(db, bookId);
  // 逐 spine 文件惰性解压 + 本次构建内 memo：绝不 unzipSync 全量（图片大文件会爆内存，
  // 见 readBookText 注释记录过的坑）。缺 entry 抛错语义与 extractChapterAcrossSpine 薄壳一致。
  const fileCache = new Map<string, string>();
  const fileText = (href: string): string => {
    const hit = fileCache.get(href);
    if (hit !== undefined) return hit;
    const entry = unzipEntry(bytes, href);
    if (!entry) throw new Error(`epub: missing entry ${href}`);
    const text = strFromU8(entry);
    fileCache.set(href, text);
    return text;
  };
  return (async () => {
    const corpus: ChapterCorpus[] = [];
    for (const ch of listChapters(db, bookId)) {
      const span = spans.get(ch.id);
      if (!span) continue;
      const text = chapterTextAcrossSpine(fileText, spine, span.start, span.end);
      corpus.push({
        chapterId: ch.id,
        chapterTitle: ch.title,
        text,
        index: buildSearchIndex({ text }),
      });
      await yieldToEventLoop();
    }
    return corpus;
  })();
}

export async function buildPdfCorpus(
  db: DB,
  bookId: string,
  bytes: Uint8Array,
  pageCount: number | null,
): Promise<ChapterCorpus[]> {
  const chapters = listChapters(db, bookId);
  const doc = await openPdf(bytes);
  try {
    const corpus: ChapterCorpus[] = [];
    for (const ch of chapters) {
      // 页范围表达式与 readChapterText 的 PDF 分支逐项一致（对齐前提）。
      const text = await chapterPdfText(doc, ch.startPage ?? 1, ch.endPage ?? pageCount ?? 1);
      corpus.push({
        chapterId: ch.id,
        chapterTitle: ch.title,
        text,
        index: buildSearchIndex({ text }),
        pageMarkers: pdfPageMarkers(text),
      });
      await yieldToEventLoop();
    }
    return corpus;
  } finally {
    await doc.cleanup();
    await doc.loadingTask.destroy();
  }
}

// book id 是内容哈希，同一 id 的字节不变；重建索引（parserVersion 升级）会换掉章节 id，故键里带版本。
// 只留最近 2 本（与 UI 搜索缓存同策略；两缓存相互独立，同本书可能各占一份）。
// 缓存内容含 DB 生成的章节 id，故键隐含「单库进程」假定（生产成立；多库测试须错开书 id）。
const CORPUS_CACHE_SIZE = 2;
const corpusCache = new Map<string, Promise<ChapterCorpus[]>>();

/** 取（必要时构建）这本书的 AI 搜索语料；扫描版 PDF 与无章节的书在此抛错（错误原文喂模型）。 */
function loadCorpus(db: DB, bookId: string, loadBytes: LoadBookBytes): Promise<ChapterCorpus[]> {
  const book = getBook(db, bookId);
  if (!book) throw new Error(`search-corpus: book ${bookId} not found`);
  if (book.format === "pdf" && !book.hasTextLayer) {
    throw new Error("this PDF is scanned and has no text layer; full-text search is unavailable");
  }
  const key = `${book.id}:${book.parserVersion ?? 0}`;
  const hit = corpusCache.get(key);
  if (hit) {
    corpusCache.delete(key);
    corpusCache.set(key, hit);
    return hit;
  }
  const built = loadBytes(book.id).then((bytes) =>
    book.format === "pdf"
      ? buildPdfCorpus(db, book.id, bytes, book.pageCount)
      : buildEpubCorpus(db, book.id, bytes),
  );
  corpusCache.set(key, built);
  built.catch(() => corpusCache.delete(key)); // 失败不缓存，下次重试
  while (corpusCache.size > CORPUS_CACHE_SIZE) {
    corpusCache.delete(corpusCache.keys().next().value!);
  }
  return built;
}

/** 在语料上搜索（纯函数）。命中按阅读顺序（章序 + 章内偏移序），至多 limit 条。 */
export function searchCorpus(
  corpus: ChapterCorpus[],
  query: string,
  limit = AI_SEARCH_MAX_HITS,
): { hits: CorpusHit[]; truncated: boolean } {
  const hits: CorpusHit[] = [];
  for (const chapter of corpus) {
    const remaining = limit - hits.length;
    const matches = findInIndex(chapter.index, query, remaining + 1);
    for (const m of matches.slice(0, remaining)) {
      const page = chapter.pageMarkers?.filter((mk) => mk.offset <= m.start).at(-1)?.page;
      hits.push({
        chapterId: chapter.chapterId,
        chapterTitle: chapter.chapterTitle,
        snippet: snippetAround({ text: chapter.text }, m, SNIPPET_RADIUS),
        chapterOffset: m.start,
        ...(page !== undefined ? { page } : {}),
      });
    }
    if (matches.length > remaining) return { hits, truncated: true };
  }
  return { hits, truncated: false };
}

/** AI 书内搜索：当前书内按关键词找命中，返回带精确定位（chapterOffset / page）的结果。 */
export async function searchBookCorpus(
  db: DB,
  bookId: string,
  query: string,
  loadBytes: LoadBookBytes,
): Promise<{ hits: CorpusHit[]; truncated: boolean }> {
  const corpus = await loadCorpus(db, bookId, loadBytes);
  if (corpus.length === 0) {
    throw new Error(
      "this book has no chapters (empty table of contents); chapter-anchored search is unavailable",
    );
  }
  return searchCorpus(corpus, query);
}
