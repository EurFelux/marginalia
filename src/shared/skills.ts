// Skill 的跨层契约（spec 2026-10-03-bash-skills-permissions-design §7）。
import { z } from "zod";

/** Agent Skills 规范：小写字母、数字、单个连字符分隔，≤ 64 字符。 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const SKILL_NAME_MAX = 64;
export const SKILL_DESCRIPTION_MAX = 1024;

/** 单个 skill 的导入大小上限（字节，MiB 的整数倍）：防止误把 node_modules 之类带进来。 */
export const SKILL_MAX_BYTES = 20 * 1024 * 1024;

/** 导入时扫描的来源目录（`~` = 用户家目录，主进程展开）。 */
export const SKILL_IMPORT_ROOTS = ["~/.agents/skills", "~/.claude/skills"] as const;

/** SKILL.md 校验失败的原因（渲染层据此本地化展示）。 */
export const skillErrorCode = z.enum([
  "missingSkillMd",
  "unreadable",
  "missingFrontmatter",
  "badYaml",
  "missingName",
  "badName",
  "missingDescription",
  "descriptionTooLong",
  /** app 目录里文件夹名与 name 不一致（导入时会按 name 建文件夹，不会出现）。要求一致也就杜绝了同名重复。 */
  "nameMismatch",
]);
export type SkillErrorCode = z.infer<typeof skillErrorCode>;

/** 设置页「已安装」列表的一行。无效的 skill 也列出来（name 退回文件夹名），附原因。 */
export interface SkillDto {
  name: string;
  description: string;
  /** app 技能目录下的文件夹名。 */
  folder: string;
  enabled: boolean;
  /** 带 `disable-model-invocation: true`：只能手动调用，暂不支持，不进索引（§7.6）。 */
  manualOnly: boolean;
  error: SkillErrorCode | null;
}

export type SkillImportStatus =
  /** 可导入。 */
  | "importable"
  /** 已导入且内容相同。 */
  | "imported"
  /** 已有同名 skill，内容不同；导入会覆盖。 */
  | "conflict"
  /** 只能手动调用，不可导入。 */
  | "manualOnly"
  /** 无效，不可导入。 */
  | "invalid";

/** 「从其他位置导入」的候选项。同一 skill 经符号链接出现在多处时只列一次。 */
export interface SkillImportCandidate {
  /** 真实路径（跟随顶层符号链接后），导入时以它为准。 */
  source: string;
  /** 扫描时发现它的路径（可能多于一个，如 ~/.claude/skills/x 链接到 ~/.agents/skills/x）。 */
  foundAt: string[];
  /** frontmatter 里的 name；无效时退回文件夹名。 */
  name: string;
  description: string;
  status: SkillImportStatus;
  error: SkillErrorCode | null;
}

export const importSkillsInput = z.object({
  /** 候选项的 source（真实路径）；主进程会重新扫描并只接受扫描结果里可导入的项。 */
  sources: z.array(z.string().min(1)).min(1).max(200),
});
export type ImportSkillsInput = z.infer<typeof importSkillsInput>;

/** 导入失败的原因：不在可导入的扫描结果里 / 无效 / 手动调用型 / 超过大小上限 / 复制失败。 */
export type SkillImportFailure = "notFound" | "invalid" | "manualOnly" | "tooLarge" | "copyFailed";

export interface SkillImportResult {
  imported: string[];
  failed: { name: string; reason: SkillImportFailure }[];
  /** 复制时跳过的 skill 内部符号链接（防止把链接指向的外部文件带进来）。 */
  skippedLinks: { name: string; paths: string[] }[];
}

/** app 技能目录下的一个文件夹名（不含路径分隔符，不是 . / ..）。 */
const skillFolder = z
  .string()
  .min(1)
  .max(255)
  .refine((f) => !/[/\\]/.test(f) && f !== "." && f !== "..", "invalid skill folder");

export const skillFolderInput = z.object({ folder: skillFolder });

/** 打开技能目录；带 folder 时打开那个 skill 的文件夹。 */
export const openSkillsDirInput = z.object({ folder: skillFolder.optional() });
