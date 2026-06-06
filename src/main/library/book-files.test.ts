import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  BookFileMissingError,
  deleteBookFile,
  readBookFile,
  storedBookPath,
  writeBookFile,
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
    const p = storedBookPath(dir, "urn:uuid:abc/def", "epub");
    expect(p.startsWith(dir)).toBe(true);
    expect(path.basename(p)).toMatch(/^[0-9a-f]{64}\.epub$/); // 哈希文件名，无 : 或 /
  });

  it("derives pdf path with .pdf extension", () => {
    const p = storedBookPath("/tmp/books", "some-book", "pdf");
    expect(p.endsWith(".pdf")).toBe(true);
  });

  it("epub path stays byte-identical to the legacy derivation", () => {
    // 既有 .epub 副本的派生路径不得改变（编码函数永久稳定约定）
    expect(storedBookPath("/tmp/books", "id-1", "epub")).toBe(
      path.join("/tmp/books", createHash("sha256").update("id-1").digest("hex") + ".epub"),
    );
  });

  it("write then read round-trips the bytes", async () => {
    const bytes = new Uint8Array([1, 2, 3]);
    await writeBookFile(dir, "book-1", "epub", bytes);
    expect(await readBookFile(dir, "book-1", "epub")).toEqual(bytes);
    // 真落到派生位置
    expect(new Uint8Array(await readFile(storedBookPath(dir, "book-1", "epub")))).toEqual(bytes);
  });

  it("read throws BookFileMissingError when the copy is absent", async () => {
    await expect(readBookFile(dir, "missing", "epub")).rejects.toBeInstanceOf(BookFileMissingError);
  });

  it("delete is best-effort (no throw when already absent)", async () => {
    await expect(deleteBookFile(dir, "never-written", "epub")).resolves.toBeUndefined();
  });
});
