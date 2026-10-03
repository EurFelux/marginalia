import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createSkillTools } from "@main/ai/skill-tools";

const root = path.join(realpathSync(mkdtempSync(path.join(tmpdir(), "skill-tools-"))), "skills");
mkdirSync(path.join(root, "notes", "references"), { recursive: true });
writeFileSync(
  path.join(root, "notes", "SKILL.md"),
  "---\nname: notes\ndescription: Notes\n---\n\nRun scripts/x.js\n",
);
writeFileSync(path.join(root, "notes", "references", "guide.md"), "# Guide\n");

function call(input: { name: string; path?: string }, disabled = new Set<string>()) {
  const { loadSkill } = createSkillTools({ skillsDir: root, disabled: () => disabled });
  return loadSkill.execute!(input, { toolCallId: "t", messages: [] } as never);
}

describe("loadSkill tool", () => {
  it("returns the skill's instructions, folder and files", async () => {
    await expect(call({ name: "notes" })).resolves.toEqual({
      name: "notes",
      dir: path.join(root, "notes"),
      content: "Run scripts/x.js\n",
      files: ["SKILL.md", "references/guide.md"],
    });
  });

  it("reads another file when given a path", async () => {
    await expect(call({ name: "notes", path: "references/guide.md" })).resolves.toMatchObject({
      content: "# Guide\n",
    });
  });

  it("returns errors to the model instead of throwing", async () => {
    await expect(call({ name: "notes" }, new Set(["notes"]))).resolves.toEqual({
      error: 'No enabled skill named "notes". Available skills: (none).',
    });
    await expect(call({ name: "notes", path: "../../etc/hosts" })).resolves.toHaveProperty("error");
  });
});
