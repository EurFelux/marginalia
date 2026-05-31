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

/** XHTML → 纯文本：块级元素文本，块间换行，规整空白。
 * Known limitations:
 *   - <pre> whitespace is collapsed (not preserved).
 *   - Char-offset slicing (in extractChapterText) may split a surrogate pair for rare
 *     supplementary-plane chars — acceptable for now.
 */
export function htmlToText(xhtml: string): string {
  const root = parseHtml(xhtml);
  const body = root.querySelector("body") ?? root;

  // Block tags we collect. NOTE: div/section are intentionally excluded — including them
  // would collapse <div><p>A</p><p>B</p></div> into one line instead of two.
  const BLOCK_TAGS = new Set([
    "h1",
    "h2",
    "h3",
    "h4",
    "h5",
    "h6",
    "p",
    "li",
    "blockquote",
    "pre",
    "figcaption",
  ]);

  // Returns true if any ancestor of the element is itself one of the BLOCK_TAGS.
  // This identifies nested blocks (e.g. <li> inside <li>'s <ul>, or <p> inside <blockquote>)
  // whose text is already included in the ancestor's .text — so we skip them to avoid duplication.
  function isNestedInsideBlock(el: ReturnType<typeof body.querySelectorAll>[number]): boolean {
    let node = el.parentNode;
    while (node) {
      // .toLowerCase() makes the check robust regardless of the node-html-parser version's rawTagName casing.
      if (node.rawTagName && BLOCK_TAGS.has(node.rawTagName.toLowerCase())) return true;
      node = node.parentNode;
    }
    return false;
  }

  const blocks = body.querySelectorAll("h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption");
  // Keep only top-level selected blocks; a block's .text already includes nested content.
  const topLevel = blocks.filter((b) => !isNestedInsideBlock(b));
  const parts = (topLevel.length ? topLevel.map((b) => b.text) : [body.text])
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
  // Clamp nextOffset so it never exceeds the text length (guards against out-of-range offsets).
  const nextOffset = Math.min(offset + slice.length, full.length);
  return { text: slice, hasMore: nextOffset < full.length, nextOffset };
}
