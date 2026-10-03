// src/main/skills/repository.ts —— app 技能目录里已安装的 skill（spec 2026-10-03-bash-skills-permissions-design §7.2–§7.5）。
// 列表是同步的：系统提示词组装（agent-context）是同步的，而技能目录只有少量小文件。
import { readdirSync, readFileSync, statSync } from "node:fs";
import { open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { parseSkillMd, type ParsedSkill } from "@main/skills/skill-file";
import type { SkillDto } from "@shared/skills";

export interface InstalledSkill {
  folder: string;
  dir: string;
  parsed: ParsedSkill;
}

/** 给模型用的 skill：有效、非手动调用型、未停用。 */
export interface AvailableSkill {
  name: string;
  description: string;
  dir: string;
}

const MAX_LISTED_FILES = 200;
const MAX_FILE_CHARS = 100_000;
/** 读附带文件时最多读入的字节（远超 MAX_FILE_CHARS，免得超大文件整读进内存）。 */
const MAX_FILE_BYTES = 1_000_000;

function readSkillMd(dir: string): ParsedSkill {
  try {
    return parseSkillMd(readFileSync(path.join(dir, "SKILL.md"), "utf8"));
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return { ok: false, error: code === "ENOENT" ? "missingSkillMd" : "unreadable" };
  }
}

/** 列出技能目录下的 skill 文件夹（跳过隐藏项与导入用的临时目录；跟随用户自己放的顶层符号链接）。 */
export function scanInstalled(root: string): InstalledSkill[] {
  let entries: string[];
  try {
    entries = readdirSync(root);
  } catch {
    return []; // 目录还不存在 = 没有 skill
  }
  const out: InstalledSkill[] = [];
  for (const folder of entries.sort()) {
    if (folder.startsWith(".")) continue;
    const dir = path.join(root, folder);
    try {
      if (!statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const parsed = readSkillMd(dir);
    out.push({
      folder,
      dir,
      parsed:
        parsed.ok && parsed.name !== folder
          ? { ok: false, error: "nameMismatch", name: parsed.name }
          : parsed,
    });
  }
  return out;
}

export function listSkills(root: string, disabled: ReadonlySet<string>): SkillDto[] {
  return scanInstalled(root).map(({ folder, parsed }) => {
    const name = parsed.ok ? parsed.name : (parsed.name ?? folder);
    return {
      name,
      description: parsed.ok ? parsed.description : "",
      folder,
      enabled: !disabled.has(name),
      manualOnly: parsed.ok && parsed.manualOnly,
      error: parsed.ok ? null : parsed.error,
    };
  });
}

export function availableSkills(root: string, disabled: ReadonlySet<string>): AvailableSkill[] {
  return scanInstalled(root).flatMap(({ dir, parsed }) =>
    parsed.ok && !parsed.manualOnly && !disabled.has(parsed.name)
      ? [{ name: parsed.name, description: parsed.description, dir }]
      : [],
  );
}

/** skill 目录内的文件（相对路径）：不跟随符号链接、跳过隐藏项，最多 MAX_LISTED_FILES 条。 */
export async function listSkillFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (rel: string): Promise<void> => {
    const entries = await readdir(path.join(dir, rel), { withFileTypes: true });
    for (const entry of entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))) {
      if (out.length >= MAX_LISTED_FILES) return;
      if (entry.name.startsWith(".")) continue;
      const child = rel ? `${rel}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child);
      else if (entry.isFile()) out.push(child);
    }
  };
  await walk("");
  return out;
}

function findAvailable(root: string, disabled: ReadonlySet<string>, name: string): AvailableSkill {
  const skills = availableSkills(root, disabled);
  const skill = skills.find((s) => s.name === name);
  if (skill) return skill;
  const known = skills.map((s) => s.name).join(", ") || "(none)";
  throw new Error(`No enabled skill named "${name}". Available skills: ${known}.`);
}

/** loadSkill 不带 path：SKILL.md 正文（不含 frontmatter）+ 目录绝对路径 + 文件清单。 */
export async function loadSkill(
  root: string,
  disabled: ReadonlySet<string>,
  name: string,
): Promise<{ name: string; dir: string; content: string; files: string[] }> {
  const skill = findAvailable(root, disabled, name);
  const parsed = readSkillMd(skill.dir);
  if (!parsed.ok) throw new Error(`Skill "${name}" could not be read.`);
  return { name, dir: skill.dir, content: parsed.body, files: await listSkillFiles(skill.dir) };
}

/**
 * loadSkill 带 path：读 skill 目录内的一个文本文件。解析后的真实路径必须仍在该 skill 目录内
 * （挡住 `..` 与指向外部的符号链接：loadSkill 不走审批，不能借它读到 skill 之外的东西）。
 */
export async function loadSkillFile(
  root: string,
  disabled: ReadonlySet<string>,
  name: string,
  relPath: string,
): Promise<{ name: string; path: string; content: string; truncated: boolean }> {
  const skill = findAvailable(root, disabled, name);
  const base = await realpath(skill.dir);
  let target: string;
  try {
    target = await realpath(path.resolve(base, relPath));
  } catch {
    throw new Error(`File "${relPath}" not found in skill "${name}".`);
  }
  if (!target.startsWith(base + path.sep)) {
    throw new Error(
      `"${relPath}" is outside skill "${name}"; only files inside the skill can be read.`,
    );
  }
  if (!(await stat(target)).isFile()) throw new Error(`"${relPath}" is not a file.`);
  const handle = await open(target, "r");
  let text: string;
  let cut: boolean;
  try {
    const { size } = await handle.stat();
    const buffer = Buffer.alloc(Math.min(size, MAX_FILE_BYTES));
    await handle.read(buffer, 0, buffer.length, 0);
    if (buffer.includes(0))
      throw new Error(`"${relPath}" is a binary file; only text files can be read.`);
    text = buffer.toString("utf8");
    cut = size > MAX_FILE_BYTES;
  } finally {
    await handle.close();
  }
  const truncated = cut || text.length > MAX_FILE_CHARS;
  return {
    name,
    path: path.relative(base, target),
    content: truncated ? text.slice(0, MAX_FILE_CHARS) : text,
    truncated,
  };
}
