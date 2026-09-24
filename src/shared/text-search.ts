/**
 * 书内搜索的匹配规则（spec 2026-09-24 in-book-search §3）：主进程搜索与渲染层锚定共用，
 * 两侧对同一文本流必须得出同样的命中序列。
 *
 * 规整（逐码点，保留「规整后下标 → 原文区间」映射）：NFKC → 小写 → 空白（含虚拟断点）折叠为
 * 单个空格 → 两个 CJK 字符之间的空白删除。查询串做同样规整。
 */

/**
 * 可搜索文本：文本流 + 虚拟断点（在 text[b] 之前插入的一个空白，不占文本流偏移）。
 * breaks 必须升序（文本流构建天然如此）。
 */
export interface SearchableText {
  text: string;
  breaks?: readonly number[];
}

/** 命中在文本流中的 [start, end)。 */
export interface TextMatch {
  start: number;
  end: number;
}

export interface Snippet {
  before: string;
  match: string;
  after: string;
}

/**
 * 规整后的文本流，可对任意多个查询复用（规整与查询无关，是搜索的主要开销）。
 * start[j] = 规整后第 j 个 UTF-16 单元来自的原文字符起点；终点由该原文字符的长度推出。
 */
export interface SearchIndex {
  source: string;
  text: string;
  start: Int32Array;
}

const CJK =
  /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\u3000-\u303f\uff00-\uffef]/u;
const WHITESPACE = /\s/u;
const EMPTY_BREAKS: readonly number[] = [];

/** 规整一个码点：ASCII 与常用汉字（U+4E00–9FFF，NFKC 与大小写都不变）走快速路径。 */
function normalizeCodePoint(cp: number): string {
  if (cp < 0x80) return String.fromCharCode(cp >= 0x41 && cp <= 0x5a ? cp + 32 : cp);
  if (cp >= 0x4e00 && cp <= 0x9fff) return String.fromCharCode(cp);
  return String.fromCodePoint(cp).normalize("NFKC").toLowerCase();
}

function isSpace(ch: string): boolean {
  const c = ch.charCodeAt(0);
  if (c < 0x80) return c === 0x20 || (c >= 0x09 && c <= 0x0d);
  return WHITESPACE.test(ch);
}

function normalize(text: string, breaks: readonly number[]): SearchIndex {
  const parts: string[] = [];
  let length = 0;
  let start = new Int32Array(text.length + 16);
  let pendingSpaceAt = -1;
  let lastChar = "";
  let nextBreak = 0;

  const push = (ch: string, from: number) => {
    parts.push(ch);
    if (length + ch.length > start.length) {
      const grown = new Int32Array(start.length * 2 + ch.length);
      grown.set(start);
      start = grown;
    }
    for (let k = 0; k < ch.length; k++) start[length++] = from;
  };

  let i = 0;
  while (i < text.length) {
    while (nextBreak < breaks.length && breaks[nextBreak]! < i) nextBreak++;
    if (breaks[nextBreak] === i && pendingSpaceAt < 0) pendingSpaceAt = i;
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    const normalized = normalizeCodePoint(cp);
    for (let k = 0; k < normalized.length; ) {
      const cpOut = normalized.codePointAt(k)!;
      const ch = String.fromCodePoint(cpOut);
      k += ch.length;
      if (isSpace(ch)) {
        if (pendingSpaceAt < 0) pendingSpaceAt = i;
        continue;
      }
      if (pendingSpaceAt >= 0) {
        // 丢掉前导空白；CJK 之间的断行 / 空白不算分隔
        if (length > 0 && !(CJK.test(lastChar) && CJK.test(ch))) push(" ", pendingSpaceAt);
        pendingSpaceAt = -1;
      }
      push(ch, i);
      lastChar = ch;
    }
    i += len;
  }
  return { source: text, text: parts.join(""), start: start.subarray(0, length) };
}

/** 为一段文本流建立可复用的搜索索引。 */
export function buildSearchIndex(source: SearchableText): SearchIndex {
  return normalize(source.text, source.breaks ?? EMPTY_BREAKS);
}

/** 顺序、非重叠地在索引中查找 query 的所有命中（至多 limit 个）。空查询无命中。 */
export function findInIndex(
  index: SearchIndex,
  query: string,
  limit = Number.POSITIVE_INFINITY,
): TextMatch[] {
  const q = normalize(query, EMPTY_BREAKS).text;
  if (q.length === 0 || limit <= 0) return [];
  const matches: TextMatch[] = [];
  for (let at = index.text.indexOf(q); at >= 0; at = index.text.indexOf(q, at + q.length)) {
    // 命中末字符不会是空格（查询规整后无首尾空白），其原文字符长度即可推出终点。
    const last = index.start[at + q.length - 1]!;
    const lastLen = index.source.codePointAt(last)! > 0xffff ? 2 : 1;
    matches.push({ start: index.start[at]!, end: last + lastLen });
    if (matches.length >= limit) break;
  }
  return matches;
}

/** 一次性查找（不复用索引）。 */
export function findMatches(
  source: SearchableText,
  query: string,
  limit = Number.POSITIVE_INFINITY,
): TextMatch[] {
  return findInIndex(buildSearchIndex(source), query, limit);
}

/** 升序数组中第一个 >= value 的下标。 */
function lowerBound(sorted: readonly number[], value: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid]! < value) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** 取 [from, to) 的显示文本：虚拟断点渲染为空格，空白折叠。includeBreakAtEnd 决定 to 处的断点归属。 */
function display(source: SearchableText, from: number, to: number, includeBreakAtEnd: boolean) {
  const all = source.breaks ?? EMPTY_BREAKS;
  // 二分定位区间内的断点（breaks 升序），避免每条命中都扫一遍全部断点。
  const breaks = includeBreakAtEnd
    ? all.slice(lowerBound(all, from + 1), lowerBound(all, to + 1))
    : all.slice(lowerBound(all, from), lowerBound(all, to));
  let s = "";
  let cursor = from;
  for (const b of breaks) {
    s += source.text.slice(cursor, b) + " ";
    cursor = b;
  }
  s += source.text.slice(cursor, to);
  return s.replace(/\s+/gu, " ");
}

/** 命中前后的上下文片段；被截断的一侧加省略号。 */
export function snippetAround(
  source: SearchableText,
  match: TextMatch,
  radius: { before: number; after: number },
): Snippet {
  const from = Math.max(0, match.start - radius.before);
  const to = Math.min(source.text.length, match.end + radius.after);
  const before = display(source, from, match.start, true);
  const after = display(source, match.end, to, false);
  return {
    before: (from > 0 ? "…" : "") + before,
    match: display(source, match.start, match.end, false).trim(),
    after: after + (to < source.text.length ? "…" : ""),
  };
}
