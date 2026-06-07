import { describe, expect, it } from "vitest";
import { findPdfTextLinks } from "./pdf-autolink";

describe("findPdfTextLinks", () => {
  it("finds explicit web URLs and trims sentence punctuation", () => {
    expect(findPdfTextLinks("See https://example.com/docs.")[0]).toEqual({
      href: "https://example.com/docs",
      start: 4,
      end: 28,
    });
  });

  it("adds https to www links", () => {
    expect(findPdfTextLinks("Visit www.example.com/foo")[0]?.href).toBe(
      "https://www.example.com/foo",
    );
  });

  it("finds email addresses as mailto links", () => {
    expect(findPdfTextLinks("Mail support@example.org")[0]?.href).toBe(
      "mailto:support@example.org",
    );
  });

  it("skips numeric TLD email matches", () => {
    expect(findPdfTextLinks("bad user@example.123")).toEqual([]);
  });
});
