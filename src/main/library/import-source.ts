import { readFileSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { zipSync, type Zippable } from "fflate";

/** 递归列出 root 下所有文件的相对路径（posix `/` 分隔），跳过点文件（.DS_Store 等）。 */
function listFilesRel(root: string): string[] {
  const walk = (abs: string): string[] => {
    const out: string[] = [];
    for (const entry of readdirSync(abs, { withFileTypes: true })) {
      if (entry.name.startsWith(".")) continue;
      const child = path.join(abs, entry.name);
      if (entry.isDirectory()) out.push(...walk(child));
      else out.push(path.relative(root, child).split(path.sep).join("/"));
    }
    return out;
  };
  return walk(root);
}

/** 把未打包的 EPUB 目录（OCF 解包形态）打包成标准 EPUB zip 字节；mimetype 居首且不压缩。 */
export function packEpubDir(dirPath: string): Uint8Array {
  const hasContainer = (() => {
    try {
      return statSync(path.join(dirPath, "META-INF", "container.xml")).isFile();
    } catch {
      return false;
    }
  })();
  if (!hasContainer) {
    throw new Error(`Not a valid EPUB directory (missing META-INF/container.xml): "${dirPath}"`);
  }

  const rels = listFilesRel(dirPath);
  const ordered = rels.includes("mimetype")
    ? ["mimetype", ...rels.filter((r) => r !== "mimetype")]
    : rels;

  const entries: Zippable = {};
  for (const rel of ordered) {
    const bytes = new Uint8Array(readFileSync(path.join(dirPath, rel)));
    entries[rel] = rel === "mimetype" ? [bytes, { level: 0 }] : bytes;
  }
  return zipSync(entries);
}
