import { mkdirSync, mkdtempSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import {
  availableSkills,
  listSkills,
  loadSkill,
  loadSkillFile,
  scanInstalled,
} from "@main/skills/repository";

const md = (name: string, description = `About ${name}`, extra = "") =>
  `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\n# ${name}\n\nSteps.\n`;

function write(file: string, content: string | Buffer) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

let root: string;
let outside: string;
const none = new Set<string>();

beforeAll(() => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "skills-repo-")));
  root = path.join(base, "skills");
  outside = path.join(base, "outside");
  write(path.join(outside, "secret.txt"), "TOP SECRET");
  write(path.join(outside, "linked-skill", "SKILL.md"), md("linked"));

  write(path.join(root, "alpha", "SKILL.md"), md("alpha"));
  write(path.join(root, "alpha", "scripts", "run.js"), "console.log('hi')\n");
  write(path.join(root, "alpha", "references", "guide.md"), "# Guide\n");
  write(path.join(root, "alpha", ".git", "config"), "[core]\n");
  write(path.join(root, "alpha", "bin.dat"), Buffer.from([1, 2, 0, 3]));
  write(path.join(root, "alpha", "big.txt"), "x".repeat(150_000));
  symlinkSync(path.join(outside, "secret.txt"), path.join(root, "alpha", "secret-link"));

  write(
    path.join(root, "beta", "SKILL.md"),
    md("beta", "Manual", "disable-model-invocation: true\n"),
  );
  write(path.join(root, "Gamma", "SKILL.md"), md("Gamma"));
  write(path.join(root, "mismatch", "SKILL.md"), md("other"));
  mkdirSync(path.join(root, "nodoc"));
  write(path.join(root, "README.txt"), "not a skill");
  write(path.join(root, ".import-tmp", "SKILL.md"), md("hidden"));
  symlinkSync(path.join(outside, "linked-skill"), path.join(root, "linked"));
});

describe("scanInstalled / listSkills", () => {
  it("lists skill folders, skipping files, hidden folders and following top-level links", () => {
    expect(scanInstalled(root).map((s) => s.folder)).toEqual([
      "Gamma",
      "alpha",
      "beta",
      "linked",
      "mismatch",
      "nodoc",
    ]);
  });

  it("reports each skill's state and the reason it is invalid", () => {
    const byFolder = Object.fromEntries(
      listSkills(root, new Set(["alpha"])).map((s) => [s.folder, s]),
    );
    expect(byFolder.alpha).toMatchObject({
      name: "alpha",
      enabled: false,
      manualOnly: false,
      error: null,
    });
    expect(byFolder.beta).toMatchObject({ name: "beta", manualOnly: true, error: null });
    expect(byFolder.Gamma).toMatchObject({ name: "Gamma", error: "badName" });
    expect(byFolder.mismatch).toMatchObject({ name: "other", error: "nameMismatch" });
    expect(byFolder.nodoc).toMatchObject({ name: "nodoc", error: "missingSkillMd" });
    expect(byFolder.linked).toMatchObject({ name: "linked", error: null });
  });

  it("returns nothing when the skills folder does not exist yet", () => {
    expect(scanInstalled(path.join(root, "missing"))).toEqual([]);
  });
});

describe("availableSkills", () => {
  it("offers only valid, model-invocable, enabled skills", () => {
    expect(availableSkills(root, none).map((s) => s.name)).toEqual(["alpha", "linked"]);
    expect(availableSkills(root, new Set(["alpha"])).map((s) => s.name)).toEqual(["linked"]);
  });
});

describe("loadSkill", () => {
  it("returns the body without frontmatter, the folder and its files", async () => {
    const skill = await loadSkill(root, none, "alpha");
    expect(skill.content).toBe("# alpha\n\nSteps.\n");
    expect(skill.dir).toBe(path.join(root, "alpha"));
    expect(skill.files).toEqual([
      "SKILL.md",
      "big.txt",
      "bin.dat",
      "references/guide.md",
      "scripts/run.js",
    ]);
  });

  it("refuses disabled, manual-only, invalid and unknown skills, listing what is available", async () => {
    for (const name of ["beta", "Gamma", "nope"]) {
      await expect(loadSkill(root, none, name)).rejects.toThrow(/Available skills: alpha, linked/);
    }
    await expect(loadSkill(root, new Set(["alpha"]), "alpha")).rejects.toThrow(/No enabled skill/);
  });
});

describe("loadSkillFile", () => {
  it("reads a text file inside the skill", async () => {
    await expect(loadSkillFile(root, none, "alpha", "references/guide.md")).resolves.toEqual({
      name: "alpha",
      path: "references/guide.md",
      content: "# Guide\n",
      truncated: false,
    });
  });

  it.each([["../beta/SKILL.md"], ["../../outside/secret.txt"], ["/etc/hosts"], ["secret-link"]])(
    "refuses to read %s outside the skill",
    async (rel) => {
      await expect(loadSkillFile(root, none, "alpha", rel)).rejects.toThrow(
        /outside skill|not found/,
      );
    },
  );

  it("refuses binary files and folders, and truncates long text", async () => {
    await expect(loadSkillFile(root, none, "alpha", "bin.dat")).rejects.toThrow(/binary/);
    await expect(loadSkillFile(root, none, "alpha", "scripts")).rejects.toThrow(/not a file/);
    const big = await loadSkillFile(root, none, "alpha", "big.txt");
    expect(big.truncated).toBe(true);
    expect(big.content).toHaveLength(100_000);
  });
});
