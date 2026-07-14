import { describe, expect, it } from "vitest";
import { setBookFinishedInput, updateBookInput } from "@shared/library";
import { readingReportStateSchema, startReadingInput } from "@shared/reading-sessions";

describe("updateBookInput", () => {
  it("accepts valid input and trims fields", () => {
    const r = updateBookInput.parse({ bookId: "b1", title: "  Clean  ", author: "  A  " });
    expect(r.title).toBe("Clean");
    expect(r.author).toBe("A");
  });

  it("accepts null author (explicit clear)", () => {
    const r = updateBookInput.parse({ bookId: "b1", title: "T", author: null });
    expect(r.author).toBeNull();
  });

  it("rejects empty or whitespace-only title", () => {
    expect(updateBookInput.safeParse({ bookId: "b", title: "", author: null }).success).toBe(false);
    expect(updateBookInput.safeParse({ bookId: "b", title: "   ", author: null }).success).toBe(
      false,
    );
  });

  it("rejects missing author key (put semantics, not patch)", () => {
    expect(updateBookInput.safeParse({ bookId: "b", title: "T" }).success).toBe(false);
  });

  it("rejects empty-string author (renderer coerces '' to null before send)", () => {
    expect(updateBookInput.safeParse({ bookId: "b", title: "T", author: "" }).success).toBe(false);
  });

  it("rejects overlong fields", () => {
    const long = "x".repeat(501);
    expect(updateBookInput.safeParse({ bookId: "b", title: long, author: null }).success).toBe(
      false,
    );
    expect(updateBookInput.safeParse({ bookId: "b", title: "T", author: long }).success).toBe(
      false,
    );
  });
});

describe("setBookFinishedInput", () => {
  it("accepts valid input", () => {
    const r = setBookFinishedInput.parse({ bookId: "b1", finished: true });
    expect(r).toEqual({ bookId: "b1", finished: true });
    expect(setBookFinishedInput.safeParse({ bookId: "b1", finished: false }).success).toBe(true);
  });

  it("rejects empty bookId", () => {
    expect(setBookFinishedInput.safeParse({ bookId: "", finished: true }).success).toBe(false);
  });

  it("rejects non-boolean / missing finished (not a patch)", () => {
    expect(setBookFinishedInput.safeParse({ bookId: "b1", finished: "yes" }).success).toBe(false);
    expect(setBookFinishedInput.safeParse({ bookId: "b1" }).success).toBe(false);
  });
});

describe("reading session contracts", () => {
  it("parses start-reading modes as a discriminated union", () => {
    expect(startReadingInput.parse({ mode: "continue", bookId: "b1" })).toEqual({
      mode: "continue",
      bookId: "b1",
    });
    expect(startReadingInput.parse({ mode: "restart", bookId: "b1" })).toEqual({
      mode: "restart",
      bookId: "b1",
    });
    expect(startReadingInput.safeParse({ mode: "continue", bookId: "" }).success).toBe(false);
  });

  it("requires content only in report states that preserve a report", () => {
    expect(readingReportStateSchema.parse({ status: "empty" })).toEqual({ status: "empty" });
    expect(
      readingReportStateSchema.safeParse({ status: "regenerating", content: "" }).success,
    ).toBe(false);
    expect(
      readingReportStateSchema.parse({
        status: "regeneration-failed",
        content: "# Kept",
        reason: "offline",
      }),
    ).toEqual({ status: "regeneration-failed", content: "# Kept", reason: "offline" });
  });
});
