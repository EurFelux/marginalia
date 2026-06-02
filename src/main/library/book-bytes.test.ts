import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import type { DB } from "@main/db/client";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { importBook } from "@main/library/repository";
import { readBookBytes } from "./book-bytes";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

describe("readBookBytes", () => {
  let db: DB;
  let dir: string;
  let bookId: string;
  let bytes: Uint8Array;

  beforeAll(async () => {
    db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    dir = await mkdtemp(path.join(tmpdir(), "marginalia-bb-"));
    bytes = makeFixtureEpub();
    const filePath = path.join(dir, "fixture.epub");
    await writeFile(filePath, bytes);
    const dto = importBook(db, { bytes, filePath });
    bookId = dto.id;
  });

  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("returns the on-disk ePub bytes for a known book", async () => {
    const out = await readBookBytes(db, bookId);
    expect(out).toBeInstanceOf(Uint8Array);
    expect(out.byteLength).toBe(bytes.byteLength);
  });

  it("throws a readable error for an unknown book", async () => {
    await expect(readBookBytes(db, "no-such-book")).rejects.toThrow(/book .* not found/);
  });
});
