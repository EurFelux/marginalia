import { strFromU8, unzipSync } from "fflate";
import { parse as parseHtml } from "node-html-parser";

export interface ReadOptions {
  offset?: number;
  maxChars?: number;
}
export interface ChapterTextSlice {
  text: string;
  hasMore: boolean;
  nextOffset: number;
}

const DEFAULT_MAX_CHARS = 20_000;

/** XHTML → 纯文本：块级元素文本，块间换行，规整空白。 */
export function htmlToText(xhtml: string): string {
  const root = parseHtml(xhtml);
  const body = root.querySelector("body") ?? root;
  const blocks = body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre");
  const parts = (blocks.length ? blocks.map((b) => b.text) : [body.text])
    .map((t) => t.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return parts.join("\n");
}

/** 从 ePub 字节里取某 href 的章节纯文本（分页）。纯函数：不碰 DB/fs。 */
export function extractChapterText(
  bytes: Uint8Array,
  href: string,
  opts: ReadOptions,
): ChapterTextSlice {
  const files = unzipSync(bytes);
  const entry = files[href];
  if (!entry) throw new Error(`epub: missing entry ${href}`);
  const full = htmlToText(strFromU8(entry));
  const offset = Math.max(0, opts.offset ?? 0);
  const maxChars = Math.max(1, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const slice = full.slice(offset, offset + maxChars);
  const nextOffset = offset + slice.length;
  return { text: slice, hasMore: nextOffset < full.length, nextOffset };
}
