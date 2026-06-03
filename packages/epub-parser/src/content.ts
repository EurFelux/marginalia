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

/**
 * 从 ePub 字节里按 href 顺序取全书纯文本，拼接到 `maxChars`。**只解压一次**（关键：逐章调
 * extractChapterText 会每次全解压 epub，N 章 = N 次全解压、同步阻塞主进程）。纯函数：不碰 DB/fs。
 */
export function extractBookText(
  bytes: Uint8Array,
  hrefs: string[],
  opts: { maxChars: number },
): { text: string; truncated: boolean } {
  const files = unzipSync(bytes); // 只解压一次
  const parts: string[] = [];
  let used = 0;
  let truncated = false;
  for (const href of hrefs) {
    const remaining = opts.maxChars - used;
    if (remaining <= 0) {
      truncated = true;
      break;
    }
    const entry = files[href];
    if (!entry) continue; // spine 列了但 zip 缺失 → 容错跳过
    const full = htmlToText(strFromU8(entry));
    const slice = full.slice(0, remaining);
    if (slice.length > 0) {
      parts.push(slice);
      used += slice.length;
    }
    if (slice.length < full.length) {
      truncated = true; // 该章被预算截断 → 停
      break;
    }
  }
  return { text: parts.join("\n\n"), truncated };
}
