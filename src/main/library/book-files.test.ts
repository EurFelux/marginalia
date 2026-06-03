import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  EpubFileMissingError,
  deleteEpubFile,
  readEpubFile,
  storedEpubPath,
  writeEpubFile,
} from "@main/library/book-files";

describe("book-files", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "marginalia-books-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("derives a filesystem-safe path from an unsafe bookId (urn/url)", () => {
    const p = storedEpubPath(dir, "urn:uuid:abc/def");
    expect(p.startsWith(dir)).toBe(true);
    expect(path.basename(p)).toMatch(/^[0-9a-f]{64}\.epub$/); // 哈希文件名，无 : 或 /
  });

  it("write then read round-trips the bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await writeEpubFile(dir, "book-1", bytes);
    expect(await readEpubFile(dir, "book-1")).toEqual(bytes);
    // 真落到派生位置
    expect(new Uint8Array(await readFile(storedEpubPath(dir, "book-1")))).toEqual(bytes);
  });

  it("read throws EpubFileMissingError when the copy is absent", async () => {
    await expect(readEpubFile(dir, "missing")).rejects.toBeInstanceOf(EpubFileMissingError);
  });

  it("delete is best-effort (no throw when already absent)", async () => {
    await expect(deleteEpubFile(dir, "never-written")).resolves.toBeUndefined();
  });
});
