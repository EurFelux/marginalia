import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { books } from "@main/db/schema";
import { importBook } from "@main/library/repository";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { coverResponseFor, sniffImageType } from "@main/library/cover-bytes";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const freshDb = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
};

describe("sniffImageType", () => {
  it("detects jpeg/png/gif/webp by magic bytes; unknown → octet-stream", () => {
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0x00]))).toBe("image/jpeg");
    expect(sniffImageType(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0, 0, 0, 0]))).toBe("image/png");
    expect(sniffImageType(new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]))).toBe("image/gif");
    expect(
      sniffImageType(new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50])),
    ).toBe("image/webp");
    expect(sniffImageType(new Uint8Array([1, 2, 3]))).toBe("application/octet-stream");
  });
});

describe("coverResponseFor", () => {
  it("returns bytes + content-type for a book that has a cover", () => {
    const db = freshDb();
    const book = importBook(db, { bytes: makeFixtureEpub() });
    const r = coverResponseFor(db, book.id);
    expect(r).not.toBeNull();
    expect(r!.bytes.byteLength).toBeGreaterThan(0);
    expect(r!.contentType).toMatch(/^image\//);
  });

  it("returns null for a book with no cover", () => {
    const db = freshDb();
    db.insert(books).values({ id: "no-cover", cover: null }).run();
    expect(coverResponseFor(db, "no-cover")).toBeNull();
  });

  it("returns null for a book whose cover is an empty blob", () => {
    const db = freshDb();
    db.insert(books)
      .values({ id: "empty-cover", cover: Buffer.alloc(0) })
      .run();
    expect(coverResponseFor(db, "empty-cover")).toBeNull();
  });

  it("returns null for an unknown book", () => {
    const db = freshDb();
    expect(coverResponseFor(db, "nope")).toBeNull();
  });
});
