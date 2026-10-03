// src/main/skills/import.ts —— 从 ~/.agents/skills、~/.claude/skills 扫描并导入 skill
// （spec 2026-10-03-bash-skills-permissions-design §7.7）。导入是一次快照：复制进 app 技能目录，不随源目录同步。
import { createHash, randomUUID } from "node:crypto";
import {
  copyFile,
  lstat,
  mkdir,
  readdir,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { createLogger } from "@main/logger";
import { parseSkillMd, type ParsedSkill } from "@main/skills/skill-file";
import type {
  SkillImportCandidate,
  SkillImportFailure,
  SkillImportResult,
  SkillImportStatus,
} from "@shared/skills";

const log = createLogger("skills");

/** 单个 skill 的大小上限：防止误把 node_modules 之类带进来。 */
export const MAX_SKILL_BYTES = 20 * 1024 * 1024;

export function defaultImportRoots(home = homedir()): string[] {
  return [path.join(home, ".agents", "skills"), path.join(home, ".claude", "skills")];
}

class TooLargeError extends Error {}

const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * 遍历 skill 文件夹里会被复制的文件：跳过隐藏项与符号链接（链接另行收集）。
 * 复制与内容指纹共用它，保证「已导入（相同）」的判定与实际复制的内容一致。
 */
async function walk(
  dir: string,
  onFile: (rel: string, abs: string, size: number) => Promise<void>,
  onDir: (rel: string) => Promise<void> = async () => {},
  rel = "",
): Promise<string[]> {
  const links: string[] = [];
  for (const name of (await readdir(path.join(dir, rel))).sort(byName)) {
    if (name.startsWith(".")) continue;
    const childRel = rel ? `${rel}/${name}` : name;
    const abs = path.join(dir, childRel);
    const info = await lstat(abs);
    if (info.isSymbolicLink()) {
      links.push(childRel);
    } else if (info.isDirectory()) {
      await onDir(childRel);
      links.push(...(await walk(dir, onFile, onDir, childRel)));
    } else if (info.isFile()) {
      await onFile(childRel, abs, info.size);
    }
  }
  return links;
}

async function digest(dir: string): Promise<string> {
  const hash = createHash("sha256");
  await walk(dir, async (rel, abs) => {
    hash
      .update(rel)
      .update("\0")
      .update(await readFile(abs))
      .update("\0");
  });
  return hash.digest("hex");
}

/** 复制到 dst（不存在则建），跳过符号链接；超过 maxBytes 抛 TooLargeError。返回跳过的链接。 */
async function copyTree(src: string, dst: string, maxBytes: number): Promise<string[]> {
  let total = 0;
  await mkdir(dst, { recursive: true });
  return walk(
    src,
    async (rel, abs, size) => {
      total += size;
      if (total > maxBytes) throw new TooLargeError(`larger than ${maxBytes} bytes`);
      await copyFile(abs, path.join(dst, rel));
    },
    async (rel) => {
      await mkdir(path.join(dst, rel), { recursive: true });
    },
  );
}

async function readSkill(dir: string): Promise<ParsedSkill> {
  try {
    return parseSkillMd(await readFile(path.join(dir, "SKILL.md"), "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, error: code === "ENOENT" ? "missingSkillMd" : "unreadable" };
  }
}

async function isDirectory(p: string): Promise<boolean> {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function statusOf(
  parsed: ParsedSkill,
  source: string,
  skillsDir: string,
): Promise<SkillImportStatus> {
  if (!parsed.ok) return "invalid";
  if (parsed.manualOnly) return "manualOnly";
  const target = path.join(skillsDir, parsed.name);
  if (!(await isDirectory(target))) return "importable";
  return (await digest(source)) === (await digest(target)) ? "imported" : "conflict";
}

/**
 * 扫描来源目录。顶层的 skill 文件夹若是符号链接则跟随（~/.claude/skills 下常是指向 ~/.agents/skills 的链接），
 * 按真实路径去重。frontmatter 的 name 与源文件夹名不一致不算错：导入时按 name 建文件夹。
 */
export async function scanImportable(
  roots: string[],
  skillsDir: string,
): Promise<SkillImportCandidate[]> {
  const bySource = new Map<string, SkillImportCandidate>();
  for (const root of roots) {
    const entries = await readdir(root).catch(() => [] as string[]);
    for (const entry of entries.sort(byName)) {
      if (entry.startsWith(".")) continue;
      const foundAt = path.join(root, entry);
      let source: string;
      try {
        source = await realpath(foundAt);
      } catch {
        continue; // 悬空链接
      }
      if (!(await isDirectory(source))) continue;
      const seen = bySource.get(source);
      if (seen) {
        seen.foundAt.push(foundAt);
        continue;
      }
      const parsed = await readSkill(source);
      bySource.set(source, {
        source,
        foundAt: [foundAt],
        name: parsed.ok ? parsed.name : (parsed.name ?? entry),
        description: parsed.ok ? parsed.description : "",
        status: await statusOf(parsed, source, skillsDir),
        error: parsed.ok ? null : parsed.error,
      });
    }
  }
  return [...bySource.values()].sort((a, b) => byName(a.name, b.name));
}

/**
 * 导入选中的候选项（以 source 真实路径指定）。主进程重新扫描、只接受扫描结果里可导入的项，
 * 不信任渲染层给的任意路径。先复制到技能目录内的隐藏临时文件夹，成功后再替换同名 skill。
 */
export async function importSkills(opts: {
  sources: string[];
  roots: string[];
  skillsDir: string;
  maxBytes?: number;
}): Promise<SkillImportResult> {
  const candidates = new Map(
    (await scanImportable(opts.roots, opts.skillsDir)).map((c) => [c.source, c]),
  );
  const result: SkillImportResult = { imported: [], failed: [], skippedLinks: [] };
  const fail = (name: string, reason: SkillImportFailure) => result.failed.push({ name, reason });
  await mkdir(opts.skillsDir, { recursive: true });

  for (const source of opts.sources) {
    const candidate = candidates.get(source);
    if (!candidate) {
      fail(path.basename(source), "notFound");
      continue;
    }
    if (candidate.status === "invalid" || candidate.status === "manualOnly") {
      fail(candidate.name, candidate.status);
      continue;
    }
    const staging = path.join(opts.skillsDir, `.import-${randomUUID()}`);
    const retired = path.join(opts.skillsDir, `.replaced-${randomUUID()}`);
    const target = path.join(opts.skillsDir, candidate.name);
    try {
      const links = await copyTree(source, staging, opts.maxBytes ?? MAX_SKILL_BYTES);
      const replacing = await isDirectory(target);
      if (replacing) await rename(target, retired);
      await rename(staging, target);
      if (replacing) await rm(retired, { recursive: true, force: true });
      result.imported.push(candidate.name);
      if (links.length > 0) result.skippedLinks.push({ name: candidate.name, paths: links });
      log.info(`imported skill ${candidate.name} from ${source}`);
    } catch (err) {
      await rm(staging, { recursive: true, force: true });
      if (err instanceof TooLargeError) {
        fail(candidate.name, "tooLarge");
      } else {
        log.warn(`importing skill ${candidate.name} failed`, err);
        fail(candidate.name, "copyFailed");
      }
    }
  }
  return result;
}
