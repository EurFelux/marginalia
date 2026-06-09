import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import { ZipArchive } from "archiver";
import yauzl from "yauzl";
import { createLogger } from "@main/logger";

const log = createLogger("backup");

/** 流式算文件 sha256（十六进制）。 */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(filePath);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

/** 写备份 zip：db 快照 → marginalia.db；books/ 目录；manifest.json。流式，大书库不入内存。 */
export function createBackupZip(opts: {
  zipPath: string;
  snapshotPath: string;
  booksDir: string;
  manifest: unknown;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(opts.zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("warning", (e) => log.warn("archive warning", e));
    archive.on("error", reject);
    archive.pipe(output);
    archive.file(opts.snapshotPath, { name: "marginalia.db" });
    if (existsSync(opts.booksDir)) archive.directory(opts.booksDir, "books");
    archive.append(JSON.stringify(opts.manifest, null, 2), { name: "manifest.json" });
    void archive.finalize();
  });
}

/** 读 zip 内单条目为 utf8 文本；条目不存在时 reject。 */
export function readZipEntryText(zipPath: string, entryName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("zip open failed"));
      let found = false;
      zip.on("entry", (entry) => {
        if (entry.fileName !== entryName) return zip.readEntry();
        found = true;
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error("zip stream failed"));
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          stream.on("error", reject);
        });
      });
      zip.on("end", () => {
        if (!found) reject(new Error(`zip entry not found: ${entryName}`));
      });
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/** 解包整个 zip 到 destDir（含 zip-slip 防御）。 */
export function extractZip(zipPath: string, destDir: string): Promise<void> {
  const root = path.resolve(destDir);
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("zip open failed"));
      zip.on("entry", (entry) => {
        const outPath = path.resolve(root, entry.fileName);
        if (outPath !== root && !outPath.startsWith(root + path.sep)) {
          return reject(new Error(`unsafe zip entry path: ${entry.fileName}`));
        }
        if (entry.fileName.endsWith("/")) {
          mkdirSync(outPath, { recursive: true });
          return zip.readEntry();
        }
        mkdirSync(path.dirname(outPath), { recursive: true });
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error("zip stream failed"));
          const ws = createWriteStream(outPath);
          stream.on("error", reject);
          ws.on("error", reject);
          ws.on("close", () => zip.readEntry());
          stream.pipe(ws);
        });
      });
      zip.on("end", () => resolve());
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}
