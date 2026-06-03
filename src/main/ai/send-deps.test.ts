import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createLoadBytes } from "@main/ai/send-deps";
import { storedEpubPath } from "@main/library/book-files";

describe("createLoadBytes", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "marginalia-send-deps-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("reads bytes for a book whose epub file exists", async () => {
    const bookId = "known-book";
    const expectedBytes = new Uint8Array([1, 2, 3]);
    await writeFile(storedEpubPath(dir, bookId), expectedBytes);

    const loadBytes = createLoadBytes(dir);
    const bytes = await loadBytes(bookId);
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });

  it("throws EpubFileMissingError for a book whose epub file is absent", async () => {
    const loadBytes = createLoadBytes(dir);
    const { EpubFileMissingError } = await import("@main/library/book-files");
    await expect(loadBytes("missing")).rejects.toBeInstanceOf(EpubFileMissingError);
  });
});
