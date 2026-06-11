import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { unzipSync } from "fflate";
import { makeFixtureEpub, parseEpub } from "@marginalia/epub-parser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { detectFormat } from "@main/library/repository";
import { packEpubDir } from "@main/library/import-source";

/** 把一份合法 epub zip 摊成「未打包 EPUB 目录」落到 destDir。 */
async function explodeEpubToDir(zip: Uint8Array, destDir: string): Promise<void> {
  for (const [rel, bytes] of Object.entries(unzipSync(zip))) {
    const abs = path.join(destDir, rel);
    await mkdir(path.dirname(abs), { recursive: true });
    await writeFile(abs, bytes);
  }
}

describe("packEpubDir", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(path.join(tmpdir(), "marginalia-epubdir-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("packs an unpacked EPUB directory into a parseable standard zip", async () => {
    const src = path.join(dir, "book.epub"); // 这是个目录
    await explodeEpubToDir(makeFixtureEpub({ title: "Roundtrip Title" }), src);

    const zip = packEpubDir(src);

    expect(zip[0]).toBe(0x50); // 'P'
    expect(zip[1]).toBe(0x4b); // 'K'
    expect(detectFormat(zip)).toBe("epub");
    expect(parseEpub(zip).title).toBe("Roundtrip Title");
  });

  it("writes mimetype as the first entry, stored (uncompressed)", async () => {
    const src = path.join(dir, "book.epub");
    await explodeEpubToDir(makeFixtureEpub(), src);

    const zip = packEpubDir(src);

    // 本地文件头：压缩方法在偏移 8（0 = stored）；文件名从偏移 30 起
    expect(zip[8]).toBe(0);
    expect(zip[9]).toBe(0);
    expect(new TextDecoder().decode(zip.subarray(30, 38))).toBe("mimetype");
  });

  it("rejects a directory that is not a valid EPUB (no META-INF/container.xml)", async () => {
    const src = path.join(dir, "not-epub.epub");
    await mkdir(path.join(src, "OEBPS"), { recursive: true });
    await writeFile(path.join(src, "mimetype"), "application/epub+zip");
    await writeFile(path.join(src, "OEBPS", "x.xhtml"), "<html></html>");
    // 故意不写 META-INF/container.xml

    expect(() => packEpubDir(src)).toThrow(/Not a valid EPUB directory/);
  });
});
