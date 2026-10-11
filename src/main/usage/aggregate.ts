import type {
  UsageBookRow,
  UsageBucket,
  UsagePurpose,
  UsageRange,
  UsageStatsDto,
  UsageTotals,
} from "@shared/stats";

/** 聚合需要的账本列。 */
export interface UsageRow {
  createdAt: number;
  purpose: UsagePurpose;
  model: string | null;
  bookId: string | null;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number | null;
}

export interface BookInfo {
  title: string | null;
  author: string | null;
}

/** 按书分布单独列出的本数；之后的并成「其余 N 本」（§3.7）。 */
export const BOOK_RANK_LIMIT = 10;

const RANGE_DAYS: Record<Exclude<UsageRange, "all">, number> = { "7d": 7, "30d": 30 };

/** 范围起点（含今天的近 N 天，本地日 00:00 的 epoch ms）；「全部」为 null。 */
export function usageRangeStart(range: UsageRange, now: Temporal.ZonedDateTime): number | null {
  if (range === "all") return null;
  return now
    .toPlainDate()
    .subtract({ days: RANGE_DAYS[range] - 1 })
    .toZonedDateTime({ timeZone: now.timeZoneId }).epochMilliseconds;
}

const emptyTotals = (): UsageTotals => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheKnownInputTokens: 0,
  requests: 0,
});

function addRow(t: UsageTotals, r: UsageRow): void {
  t.inputTokens += r.inputTokens;
  t.outputTokens += r.outputTokens;
  t.requests += r.requests;
  if (r.cacheReadTokens != null) {
    t.cacheReadTokens += r.cacheReadTokens;
    t.cacheKnownInputTokens += r.inputTokens;
  }
}

const tokensOf = (t: { inputTokens: number; outputTokens: number }) =>
  t.inputTokens + t.outputTokens;

/**
 * 账本行 → 统计页「AI 用量」数据（spec 2026-10-12-ai-usage-stats-design §3、§4.5）。
 * 纯函数：当前时刻与时区由调用方注入；只统计落在范围内的行。
 */
export function aggregateUsage(
  rows: readonly UsageRow[],
  range: UsageRange,
  now: Temporal.ZonedDateTime,
  books: ReadonlyMap<string, BookInfo>,
  hasAnyUsage: boolean,
): UsageStatsDto {
  const days = range === "all" ? null : RANGE_DAYS[range];
  const start = usageRangeStart(range, now);
  const inRange = start == null ? rows : rows.filter((r) => r.createdAt >= start);
  const zone = now.timeZoneId;
  const localDate = (ms: number) =>
    Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(zone).toPlainDate();

  const totals = emptyTotals();
  const purposes = new Map<UsagePurpose, number>();
  const models = new Map<string | null, UsageTotals>();
  const perBook = new Map<string | null, number>();
  for (const r of inRange) {
    addRow(totals, r);
    purposes.set(r.purpose, (purposes.get(r.purpose) ?? 0) + tokensOf(r));
    const m = models.get(r.model) ?? emptyTotals();
    addRow(m, r);
    models.set(r.model, m);
    perBook.set(r.bookId, (perBook.get(r.bookId) ?? 0) + tokensOf(r));
  }

  // 用量图：近 N 天按天、「全部」按月（从最早一条所在月到本月），零填充
  const granularity = days == null ? "month" : "day";
  const keyOf =
    granularity === "day"
      ? (ms: number) => localDate(ms).toString()
      : (ms: number) => localDate(ms).toPlainYearMonth().toString();
  const keys: string[] = [];
  if (days != null) {
    const today = now.toPlainDate();
    for (let i = days - 1; i >= 0; i--) keys.push(today.subtract({ days: i }).toString());
  } else if (inRange.length > 0) {
    // 不用 Math.min(...)：行数可达十万级，展开传参会撑爆调用栈
    const earliest = inRange.reduce((min, r) => Math.min(min, r.createdAt), Infinity);
    const last = now.toPlainDate().toPlainYearMonth();
    let month = localDate(earliest).toPlainYearMonth();
    for (; Temporal.PlainYearMonth.compare(month, last) <= 0; month = month.add({ months: 1 })) {
      keys.push(month.toString());
    }
  }
  const buckets = new Map<string, UsageBucket>(keys.map((key) => [key, { key, ...emptyTotals() }]));
  for (const r of inRange) {
    const b = buckets.get(keyOf(r.createdAt));
    if (b) addRow(b, r);
  }

  return {
    hasAnyUsage,
    granularity,
    days,
    totals,
    series: [...buckets.values()],
    byPurpose: [...purposes]
      .map(([purpose, tokens]) => ({ purpose, tokens }))
      .filter((p) => p.tokens > 0)
      .sort((a, b) => b.tokens - a.tokens),
    byModel: [...models]
      .map(([model, t]) => ({ model, ...t }))
      .sort((a, b) => tokensOf(b) - tokensOf(a)),
    byBook: bookRows(perBook, books),
  };
}

/** 按书分布：前 BOOK_RANK_LIMIT 本，然后依次是其余 N 本、不属于某本书、已删除的书（§3.7）。 */
function bookRows(
  perBook: ReadonlyMap<string | null, number>,
  books: ReadonlyMap<string, BookInfo>,
): UsageBookRow[] {
  const ranked: Extract<UsageBookRow, { kind: "book" }>[] = [];
  let none = 0;
  const deleted = { count: 0, tokens: 0 };
  for (const [bookId, tokens] of perBook) {
    if (tokens <= 0) continue;
    if (bookId == null) {
      none += tokens;
      continue;
    }
    const info = books.get(bookId);
    if (!info) {
      deleted.count += 1;
      deleted.tokens += tokens;
      continue;
    }
    ranked.push({ kind: "book", bookId, title: info.title, author: info.author, tokens });
  }
  ranked.sort((a, b) => b.tokens - a.tokens);
  const rest = ranked.slice(BOOK_RANK_LIMIT);
  const rows: UsageBookRow[] = ranked.slice(0, BOOK_RANK_LIMIT);
  if (rest.length > 0) {
    rows.push({
      kind: "others",
      count: rest.length,
      tokens: rest.reduce((s, b) => s + b.tokens, 0),
    });
  }
  if (none > 0) rows.push({ kind: "none", tokens: none });
  if (deleted.count > 0) rows.push({ kind: "deleted", ...deleted });
  return rows;
}
