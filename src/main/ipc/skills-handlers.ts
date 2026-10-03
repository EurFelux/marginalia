import { mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { shell } from "electron";
import { C } from "@shared/ipc";
import { appService } from "@main/app";
import { invalidateAllAgentContexts } from "@main/ai/agent-context";
import { getDb } from "@main/db/instance";
import { bind, register, type Binding } from "@main/ipc/registry";
import { getPreference, setPreference } from "@main/preferences/repository";
import { defaultImportRoots, importSkills, scanImportable } from "@main/skills/import";
import { listSkills } from "@main/skills/repository";

const skillsDir = () => appService.getPath("skillsDir");
const disabledSkills = () => getPreference(getDb(), "disabledSkills") ?? [];

export const skillsBindings: Binding[] = [
  bind(C.skillsList, () => listSkills(skillsDir(), new Set(disabledSkills()))),

  bind(C.skillsScanImportable, () => scanImportable(defaultImportRoots(), skillsDir())),

  // 导入、删除都会改变技能索引：清空会话快照，下一轮生效（spec 2026-10-03 §7.4）。
  bind(C.skillsImport, async (input) => {
    const result = await importSkills({
      sources: input.sources,
      roots: defaultImportRoots(),
      skillsDir: skillsDir(),
    });
    if (result.imported.length > 0) invalidateAllAgentContexts();
    return result;
  }),

  bind(C.skillsDelete, async ({ folder }) => {
    const dir = path.join(skillsDir(), folder);
    if (!(await stat(dir).catch(() => null))?.isDirectory()) {
      throw new Error(`skill folder not found: ${folder}`);
    }
    const name = listSkills(skillsDir(), new Set()).find((s) => s.folder === folder)?.name;
    await shell.trashItem(dir);
    // 停用列表里删掉它：以后重新导入同名 skill 不该默认是停用的。
    const disabled = disabledSkills();
    if (name && disabled.includes(name)) {
      setPreference(
        getDb(),
        "disabledSkills",
        disabled.filter((n) => n !== name),
      );
    }
    invalidateAllAgentContexts();
  }),

  bind(C.skillsOpenDir, async ({ folder }) => {
    await mkdir(skillsDir(), { recursive: true });
    await appService.openFolder(folder ? path.join(skillsDir(), folder) : skillsDir());
  }),
];

export function registerSkillsHandlers(): void {
  register(skillsBindings);
}
