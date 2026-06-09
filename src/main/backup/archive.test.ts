import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBackupZip, extractZip, readZipEntryText, sha256File } from "@main/backup/archive";

function tmp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("archive helpers", () => {
  it("sha256File hashes deterministically", async () => {
    const dir = tmp("arch-hash-");
    const f = path.join(dir, "x.bin");
    writeFileSync(f, "hello");
    // sha256("hello")
    expect(await sha256File(f)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("zip → read manifest → extract roundtrips db + books", async () => {
    const src = tmp("arch-src-");
    const snapshot = path.join(src, "snap.db");
    writeFileSync(snapshot, "DBDATA");
    const booksDir = path.join(src, "books");
    mkdirSync(booksDir);
    writeFileSync(path.join(booksDir, "a.epub"), "BOOK-A");

    const zipPath = path.join(src, "out.zip");
    await createBackupZip({
      zipPath,
      snapshotPath: snapshot,
      booksDir,
      manifest: { hello: "world" },
    });
    expect(existsSync(zipPath)).toBe(true);

    const manifestText = await readZipEntryText(zipPath, "manifest.json");
    expect(JSON.parse(manifestText)).toEqual({ hello: "world" });

    const dest = tmp("arch-dest-");
    await extractZip(zipPath, dest);
    expect(readFileSync(path.join(dest, "marginalia.db"), "utf8")).toBe("DBDATA");
    expect(readFileSync(path.join(dest, "books", "a.epub"), "utf8")).toBe("BOOK-A");
  });

  it("readZipEntryText rejects a missing entry", async () => {
    const src = tmp("arch-miss-");
    const snapshot = path.join(src, "snap.db");
    writeFileSync(snapshot, "X");
    const booksDir = path.join(src, "books");
    mkdirSync(booksDir);
    const zipPath = path.join(src, "out.zip");
    await createBackupZip({ zipPath, snapshotPath: snapshot, booksDir, manifest: {} });
    await expect(readZipEntryText(zipPath, "nope.json")).rejects.toThrow();
  });
});
