import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { importBook, resolveChapterByHref } from "@main/library/repository";
import { getChapterSummary, getToc, readChapterText } from "@main/library/content";
import { makeFixtureEpub } from "@marginalia/epub-parser";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const setup = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const bytes = makeFixtureEpub();
  const book = importBook(db, { bytes, filePath: "/b.epub" });
  return { db, bytes, book };
};

describe("content service", () => {
  it("getToc returns the stored, schema-validated toc", () => {
    const { db, book } = setup();
    expect(getToc(db, book.id)).toEqual([
      { label: "Chapter One", href: "OEBPS/ch1.xhtml" },
      { label: "Chapter Two", href: "OEBPS/ch2.xhtml" },
    ]);
  });
  it("readChapterText returns plain text via the parser package", () => {
    const { db, bytes, book } = setup();
    const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml")!;
    const r = readChapterText(db, bytes, book.id, ch1.id, {});
    expect(r.text).toContain("Hello world.");
    expect(r.hasMore).toBe(false);
  });
  it("getChapterSummary returns pending by default", () => {
    const { db, book } = setup();
    const ch1 = resolveChapterByHref(db, book.id, "OEBPS/ch1.xhtml")!;
    expect(getChapterSummary(db, book.id, ch1.id)).toEqual({ status: "pending", summary: null });
  });
});
