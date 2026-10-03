// src/main/skills/skill-file.ts —— 解析与校验 SKILL.md（spec 2026-10-03-bash-skills-permissions-design §7.1）。
// 兼容 Agent Skills：YAML frontmatter 的 name / description 必填；disable-model-invocation 标记手动调用型；
// 其余字段（license、metadata、allowed-tools、argument-hint、user-invocable…）一律忽略，skill 不能借此自带授权。
import { parse as parseYaml } from "yaml";
import {
  SKILL_DESCRIPTION_MAX,
  SKILL_NAME_MAX,
  SKILL_NAME_RE,
  type SkillErrorCode,
} from "@shared/skills";

export type ParsedSkill =
  | { ok: true; name: string; description: string; manualOnly: boolean; body: string }
  | { ok: false; error: SkillErrorCode; /** 能读出合法 name 时带上，方便展示。 */ name?: string };

const FRONTMATTER = /^﻿?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

export function parseSkillMd(text: string): ParsedSkill {
  const match = FRONTMATTER.exec(text);
  if (!match) return { ok: false, error: "missingFrontmatter" };
  let data: unknown;
  try {
    data = parseYaml(match[1]!);
  } catch {
    return { ok: false, error: "badYaml" };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "badYaml" };
  }
  const fields = data as Record<string, unknown>;
  const name = typeof fields.name === "string" ? fields.name.trim() : "";
  if (!name) return { ok: false, error: "missingName" };
  if (name.length > SKILL_NAME_MAX || !SKILL_NAME_RE.test(name)) {
    return { ok: false, error: "badName" };
  }
  const description = typeof fields.description === "string" ? fields.description.trim() : "";
  if (!description) return { ok: false, error: "missingDescription", name };
  if (description.length > SKILL_DESCRIPTION_MAX) {
    return { ok: false, error: "descriptionTooLong", name };
  }
  return {
    ok: true,
    name,
    description,
    manualOnly: fields["disable-model-invocation"] === true,
    body: text.slice(match[0].length).replace(/^\s*\n/, ""),
  };
}
