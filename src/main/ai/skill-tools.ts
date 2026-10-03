// src/main/ai/skill-tools.ts —— loadSkill 工具（spec 2026-10-03-bash-skills-permissions-design §7.5）。
// 只读、不走审批：只读用户自己放进技能目录的东西，且路径限定在该 skill 文件夹内。skill 里的脚本经 bash 执行，照常审批。
import { tool } from "ai";
import { z } from "zod";
import { runTool } from "@main/ai/tools";
import { loadSkill, loadSkillFile } from "@main/skills/repository";

export interface SkillToolDeps {
  skillsDir: string;
  /** 每次调用时读：会话中途停用的 skill 立即不可加载。 */
  disabled: () => ReadonlySet<string>;
}

const DESCRIPTION = [
  "Load a skill from the Skills list. Returns its instructions (content), its folder (dir) and the files it contains.",
  "Call it before working on a task that matches a skill, then follow the instructions.",
  "Pass path to read another text file of the skill, relative to its folder.",
  "To run a skill's scripts, use the bash tool with paths under dir.",
].join(" ");

export function createSkillTools(deps: SkillToolDeps) {
  return {
    loadSkill: tool({
      description: DESCRIPTION,
      inputSchema: z.object({
        name: z.string().min(1).describe("The skill's name, as listed under Skills."),
        path: z
          .string()
          .min(1)
          .optional()
          .describe(
            "A file inside the skill folder to read instead of SKILL.md, e.g. references/guide.md.",
          ),
      }),
      execute: ({ name, path }) =>
        runTool(
          "loadSkill",
          async (): Promise<object> =>
            path
              ? loadSkillFile(deps.skillsDir, deps.disabled(), name, path)
              : loadSkill(deps.skillsDir, deps.disabled(), name),
        ),
    }),
  };
}
