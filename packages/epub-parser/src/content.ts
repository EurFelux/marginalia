import { strFromU8, unzipSync } from "fflate";
import { parse as parseHtml, type HTMLElement } from "node-html-parser";
import { readSpine } from "./parse";

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

const BLOCK_SELECTOR = "h1,h2,h3,h4,h5,h6,p,li,blockquote,pre,figcaption";
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

/** 该元素是否嵌在另一块级元素内（其文本已被祖先块收集，跳过以免重复）。 */
function isNestedInsideBlock(el: HTMLElement): boolean {
  let node = el.parentNode as HTMLElement | null;
  while (node) {
    if (node.rawTagName && BLOCK_TAGS.has(node.rawTagName.toLowerCase())) return true;
    node = node.parentNode as HTMLElement | null;
  }
  return false;
}

/** 顶层块级元素（保序）：querySelectorAll 命中后剔除嵌套块。 */
function topLevelBlocks(body: HTMLElement): HTMLElement[] {
  return body.querySelectorAll(BLOCK_SELECTOR).filter((b) => !isNestedInsideBlock(b));
}

/** 取某 anchor 所在 spine 文件的「本章块级文本」：[anchor 所在块, nextAnchor 所在块) 区间。 */
function sliceTextByAnchor(xhtml: string, anchor: string, nextAnchor?: string): string {
  const root = parseHtml(xhtml);
  const body = (root.querySelector("body") ?? root) as HTMLElement;
  const startEl = root.getElementById(anchor);
  if (!startEl) return htmlToText(xhtml); // 定位不到 ⇒ 退化整文件（不静默空）
  const startOffset = startEl.range[0];
  const endEl = nextAnchor ? root.getElementById(nextAnchor) : null;
  const endOffset = endEl ? endEl.range[0] : Number.POSITIVE_INFINITY;
  const parts = topLevelBlocks(body)
    .filter((b) => b.range[1] > startOffset && b.range[1] <= endOffset)
    .map((b) => b.text.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  return parts.join("\n");
}

/**
 * 取单个 spine 文件内 [fromAnchor 所在块, toAnchor 所在块) 的块级文本（跨文件抽取的逐文件原语）。
 * fromAnchor 省略 ⇒ 从文件开头；toAnchor 省略 ⇒ 到文件结尾。锚点元素找不到时该端退化为开头/结尾
 * （不静默丢正文）。与 sliceTextByAnchor 的差异：fromAnchor 缺失时按「从头」取块，而非整文件 htmlToText 回退。
 */
function sliceFileBlocks(xhtml: string, fromAnchor?: string, toAnchor?: string): string {
  const root = parseHtml(xhtml);
  const body = (root.querySelector("body") ?? root) as HTMLElement;
  const fromEl = fromAnchor ? root.getElementById(fromAnchor) : null;
  const fromOffset = fromEl ? fromEl.range[0] : 0;
  const toEl = toAnchor ? root.getElementById(toAnchor) : null;
  const toOffset = toEl ? toEl.range[0] : Number.POSITIVE_INFINITY;
  return topLevelBlocks(body)
    .filter((b) => b.range[1] > fromOffset && b.range[1] <= toOffset)
    .map((b) => b.text.replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
}

/** 把整章纯文本按 offset/maxChars 分页成 ChapterTextSlice（nextOffset 永不越界）。 */
function paginate(full: string, opts: ReadOptions): ChapterTextSlice {
  const offset = Math.max(0, opts.offset ?? 0);
  const maxChars = Math.max(1, opts.maxChars ?? DEFAULT_MAX_CHARS);
  const slice = full.slice(offset, offset + maxChars);
  const nextOffset = Math.min(offset + slice.length, full.length);
  return { text: slice, hasMore: nextOffset < full.length, nextOffset };
}

/** XHTML → 纯文本：块级元素文本，块间换行，规整空白。
 * Known limitations:
 *   - <pre> whitespace is collapsed (not preserved).
 *   - Char-offset slicing (in extractChapterText) may split a surrogate pair for rare
 *     supplementary-plane chars — acceptable for now.
 */
export function htmlToText(xhtml: string): string {
  const root = parseHtml(xhtml);
  const body = (root.querySelector("body") ?? root) as HTMLElement;

  // Keep only top-level selected blocks; a block's .text already includes nested content.
  const topLevel = topLevelBlocks(body);
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
  anchor?: string,
  nextAnchor?: string,
): ChapterTextSlice {
  const files = unzipSync(bytes);
  const entry = files[href];
  if (!entry) throw new Error(`epub: missing entry ${href}`);
  const xhtml = strFromU8(entry);
  const full = anchor ? sliceTextByAnchor(xhtml, anchor, nextAnchor) : htmlToText(xhtml);
  return paginate(full, opts);
}

/**
 * 取「一个 TOC 章节」的纯文本——可横跨多个连续 spine 文档（分页）。纯函数：不碰 DB/fs。
 *
 * 背景：一个目录项的正文常被切成多个 spine 文件（如 `part_012`=标题 + `part_013`=正文主体），
 * 而中间那些没有独立目录项的「孤儿」spine 文件逻辑上属于本章。按单 href 抽取会整段漏掉它们。
 *
 * 区间语义：本章正文 = 从 `start`(href, anchor) 到 `end`(下一目录项的 href, anchor) 之前，按 spine
 * 阅读顺序拼接。`end` 省略表示读到全书末尾（末章）。
 *   - 首文件：从 start.anchor 起到文件尾（anchor 省略 ⇒ 整文件）。
 *   - 中间文件：整取（被旧逻辑漏掉的孤儿文件）。
 *   - 末文件：仅当 end.anchor 明确存在才纳入 [文件首, end.anchor)；end.anchor 省略表示下一章从该文件
 *     开头起、本章不含它。
 * 防御：start.href 不在 spine、或 end 早于 start / 不在 spine（畸形 TOC）⇒ 保守只抽 start 文件，
 * 既不静默丢正文、也不把后文整本拽进本章。
 */
export function extractChapterAcrossSpine(
  bytes: Uint8Array,
  start: { href: string; anchor?: string },
  end: { href: string; anchor?: string } | undefined,
  opts: ReadOptions,
): ChapterTextSlice {
  const files = unzipSync(bytes);
  const fileText = (href: string): string => {
    const entry = files[href];
    if (!entry) throw new Error(`epub: missing entry ${href}`);
    return strFromU8(entry);
  };
  const spine = readSpine(files).map((s) => s.href);
  const startIdx = spine.indexOf(start.href);
  const endIdx = end ? spine.indexOf(end.href) : spine.length;

  const segments: string[] = [];
  if (startIdx === -1) {
    // start.href 不在 spine（异常）：退化为仅该文件，同文件 end 才参与切界。
    const sameFileEnd = end && end.href === start.href ? end.anchor : undefined;
    segments.push(sliceFileBlocks(fileText(start.href), start.anchor, sameFileEnd));
  } else if (end && endIdx === startIdx) {
    // 同一 spine 文件内的相邻锚点边界（含「父章 → 首个子节」）：[start.anchor, end.anchor)。
    segments.push(sliceFileBlocks(fileText(start.href), start.anchor, end.anchor));
  } else if (!end || endIdx > startIdx) {
    // 正常跨文件，或读到书末（end 省略）。
    const lastExclusive = end ? endIdx : spine.length;
    segments.push(sliceFileBlocks(fileText(start.href), start.anchor, undefined));
    for (let i = startIdx + 1; i < lastExclusive; i++) {
      segments.push(sliceFileBlocks(fileText(spine[i]!), undefined, undefined));
    }
    if (end?.anchor)
      segments.push(sliceFileBlocks(fileText(spine[endIdx]!), undefined, end.anchor));
  } else {
    // 边界异常（end 早于 start / 不在 spine）：保守只取 start 文件，不臆测区间。
    segments.push(sliceFileBlocks(fileText(start.href), start.anchor, undefined));
  }
  return paginate(segments.filter(Boolean).join("\n"), opts);
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
