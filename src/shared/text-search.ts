/**
 * 书内搜索的匹配规则（spec 2026-09-24 in-book-search §3）：主进程搜索与渲染层锚定共用，
 * 两侧对同一文本流必须得出同样的命中序列。
 *
 * 规整（逐码点，保留「规整后下标 → 原文区间」映射）：NFKC → 小写 → 空白（含虚拟断点）折叠为
 * 单个空格 → 两个 CJK 字符之间的空白删除。查询串做同样规整。
 */

/** 可搜索文本：文本流 + 虚拟断点（在 text[b] 之前插入的一个空白，不占文本流偏移）。 */
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

const CJK = /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}　-〿＀-￯]/u;
const WHITESPACE = /\s/u;

interface Normalized {
  text: string;
  /** 规整后第 j 个 UTF-16 单元对应原文字符的起点 / 终点。 */
  start: number[];
  end: number[];
}

function normalize(text: string, breaks: ReadonlySet<number>): Normalized {
  let out = "";
  const start: number[] = [];
  const end: number[] = [];
  let pendingSpaceAt: number | null = null;
  let lastChar = "";

  const push = (ch: string, from: number, to: number) => {
    out += ch;
    for (let k = 0; k < ch.length; k++) {
      start.push(from);
      end.push(to);
    }
  };
  const flushSpace = (next: string) => {
    if (pendingSpaceAt === null) return;
    const at = pendingSpaceAt;
    pendingSpaceAt = null;
    if (out.length === 0) return; // 丢掉前导空白
    if (CJK.test(lastChar) && CJK.test(next)) return; // CJK 之间的断行 / 空白不算分隔
    push(" ", at, at);
  };

  let i = 0;
  while (i < text.length) {
    if (breaks.has(i) && pendingSpaceAt === null) pendingSpaceAt = i;
    const cp = text.codePointAt(i)!;
    const len = cp > 0xffff ? 2 : 1;
    for (const ch of String.fromCodePoint(cp).normalize("NFKC").toLowerCase()) {
      if (WHITESPACE.test(ch)) {
        if (pendingSpaceAt === null) pendingSpaceAt = i;
        continue;
      }
      flushSpace(ch);
      push(ch, i, i + len);
      lastChar = ch;
    }
    i += len;
  }
  return { text: out, start, end };
}

const NO_BREAKS: ReadonlySet<number> = new Set();

/** 顺序、非重叠地查找 query 在文本流中的所有命中（至多 limit 个）。空查询无命中。 */
export function findMatches(
  source: SearchableText,
  query: string,
  limit = Number.POSITIVE_INFINITY,
): TextMatch[] {
  const q = normalize(query, NO_BREAKS).text;
  if (q.length === 0 || limit <= 0) return [];
  const hay = normalize(source.text, new Set(source.breaks ?? []));
  const matches: TextMatch[] = [];
  for (let at = hay.text.indexOf(q); at >= 0; at = hay.text.indexOf(q, at + q.length)) {
    matches.push({ start: hay.start[at]!, end: hay.end[at + q.length - 1]! });
    if (matches.length >= limit) break;
  }
  return matches;
}

/** 取 [from, to) 的显示文本：虚拟断点渲染为空格，空白折叠。includeBreakAtEnd 决定 to 处的断点归属。 */
function display(source: SearchableText, from: number, to: number, includeBreakAtEnd: boolean) {
  const breaks = (source.breaks ?? []).filter((b) =>
    includeBreakAtEnd ? b > from && b <= to : b >= from && b < to,
  );
  let s = "";
  let cursor = from;
  for (const b of [...breaks].sort((x, y) => x - y)) {
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
