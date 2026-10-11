import { describe, expect, it } from "vitest";
import {
  aggregateUsage,
  BOOK_RANK_LIMIT,
  usageRangeStart,
  type UsageRow,
} from "@main/usage/aggregate";

const ZONE = "Asia/Shanghai";
const NOW = Temporal.ZonedDateTime.from("2026-10-12T15:00:00[Asia/Shanghai]");
const at = (iso: string) => Temporal.ZonedDateTime.from(`${iso}[${ZONE}]`).epochMilliseconds;

function row(over: Partial<UsageRow> & { createdAt: number }): UsageRow {
  return {
    purpose: "chat",
    model: "claude-sonnet-5-5",
    bookId: null,
    requests: 1,
    inputTokens: 100,
    outputTokens: 10,
    cacheReadTokens: null,
    ...over,
  };
}

describe("usageRangeStart", () => {
  it("starts at local midnight N-1 days ago, and is open for all", () => {
    expect(usageRangeStart("7d", NOW)).toBe(at("2026-10-06T00:00"));
    expect(usageRangeStart("30d", NOW)).toBe(at("2026-09-13T00:00"));
    expect(usageRangeStart("all", NOW)).toBeNull();
  });
});

describe("aggregateUsage", () => {
  it("buckets by local day with zero-filled days, splitting at local midnight", () => {
    const dto = aggregateUsage(
      [
        row({ createdAt: at("2026-10-11T23:59"), inputTokens: 100 }),
        row({ createdAt: at("2026-10-12T00:01"), inputTokens: 200 }),
        row({ createdAt: at("2026-10-05T23:59"), inputTokens: 999 }), // 范围外
      ],
      "7d",
      NOW,
      new Map(),
      true,
    );
    expect(dto.granularity).toBe("day");
    expect(dto.days).toBe(7);
    expect(dto.series.map((b) => b.key)).toEqual([
      "2026-10-06",
      "2026-10-07",
      "2026-10-08",
      "2026-10-09",
      "2026-10-10",
      "2026-10-11",
      "2026-10-12",
    ]);
    expect(dto.series.at(-2)?.inputTokens).toBe(100);
    expect(dto.series.at(-1)?.inputTokens).toBe(200);
    expect(dto.totals.inputTokens).toBe(300);
  });

  it("buckets all-time usage by local month from the earliest month to now", () => {
    const dto = aggregateUsage(
      [
        row({ createdAt: at("2026-07-31T23:30"), inputTokens: 5 }),
        row({ createdAt: at("2026-10-01T00:10"), inputTokens: 7 }),
      ],
      "all",
      NOW,
      new Map(),
      true,
    );
    expect(dto.granularity).toBe("month");
    expect(dto.days).toBeNull();
    expect(dto.series.map((b) => [b.key, b.inputTokens])).toEqual([
      ["2026-07", 5],
      ["2026-08", 0],
      ["2026-09", 0],
      ["2026-10", 7],
    ]);
  });

  it("counts only rows that reported cache reads in the hit-rate denominator", () => {
    const dto = aggregateUsage(
      [
        row({ createdAt: at("2026-10-12T10:00"), inputTokens: 100, cacheReadTokens: 80 }),
        row({ createdAt: at("2026-10-12T11:00"), inputTokens: 300, cacheReadTokens: null }),
        row({
          createdAt: at("2026-10-12T12:00"),
          inputTokens: 100,
          cacheReadTokens: 0,
          requests: 3,
        }),
      ],
      "7d",
      NOW,
      new Map(),
      true,
    );
    expect(dto.totals).toEqual({
      inputTokens: 500,
      outputTokens: 30,
      cacheReadTokens: 80,
      cacheKnownInputTokens: 200,
      requests: 5,
    });
  });

  it("breaks usage down by purpose and model, largest first", () => {
    const t = at("2026-10-12T10:00");
    const dto = aggregateUsage(
      [
        row({ createdAt: t, purpose: "summary", inputTokens: 500, model: "deepseek-chat" }),
        row({ createdAt: t, purpose: "chat", inputTokens: 100 }),
        row({ createdAt: t, purpose: "chat", inputTokens: 100, model: null }),
      ],
      "30d",
      NOW,
      new Map(),
      true,
    );
    expect(dto.byPurpose).toEqual([
      { purpose: "summary", tokens: 510 },
      { purpose: "chat", tokens: 220 },
    ]);
    expect(dto.byModel.map((m) => m.model)).toEqual(["deepseek-chat", "claude-sonnet-5-5", null]);
  });

  it("ranks books, then folds the rest, book-less usage and deleted books into summary rows", () => {
    const t = at("2026-10-12T10:00");
    const books = new Map(
      Array.from({ length: BOOK_RANK_LIMIT + 2 }, (_, i) => [
        `b${i}`,
        { title: `Book ${i}`, author: null },
      ]),
    );
    const rows = [
      ...Array.from({ length: BOOK_RANK_LIMIT + 2 }, (_, i) =>
        row({ createdAt: t, bookId: `b${i}`, inputTokens: 1000 - i * 10, outputTokens: 0 }),
      ),
      row({ createdAt: t, bookId: null, inputTokens: 50, outputTokens: 0 }),
      row({ createdAt: t, bookId: "gone-1", inputTokens: 30, outputTokens: 0 }),
      row({ createdAt: t, bookId: "gone-2", inputTokens: 20, outputTokens: 0 }),
    ];
    const dto = aggregateUsage(rows, "30d", NOW, books, true);
    const book = dto.byBook.filter((b) => b.kind === "book");
    expect(book).toHaveLength(BOOK_RANK_LIMIT);
    expect(book[0]).toEqual({
      kind: "book",
      bookId: "b0",
      title: "Book 0",
      author: null,
      tokens: 1000,
    });
    expect(dto.byBook.slice(BOOK_RANK_LIMIT)).toEqual([
      { kind: "others", count: 2, tokens: 900 + 890 },
      { kind: "none", tokens: 50 },
      { kind: "deleted", count: 2, tokens: 50 },
    ]);
  });

  it("returns zeroed data for a range with no usage", () => {
    const dto = aggregateUsage([], "7d", NOW, new Map(), true);
    expect(dto.hasAnyUsage).toBe(true);
    expect(dto.totals.inputTokens).toBe(0);
    expect(dto.series).toHaveLength(7);
    expect(dto.byPurpose).toEqual([]);
    expect(dto.byModel).toEqual([]);
    expect(dto.byBook).toEqual([]);
    expect(aggregateUsage([], "all", NOW, new Map(), false).series).toEqual([]);
  });
});
