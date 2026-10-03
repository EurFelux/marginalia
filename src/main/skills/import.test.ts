import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { defaultImportRoots, importSkills, scanImportable } from "@main/skills/import";

const md = (name: string, extra = "") =>
  `---\nname: ${name}\ndescription: About ${name}\n${extra}---\n\n# ${name}\n`;

function write(file: string, content: string) {
  mkdirSync(path.dirname(file), { recursive: true });
  writeFileSync(file, content);
}

let agents: string;
let claude: string;
let skillsDir: string;
let outside: string;

beforeEach(() => {
  const base = realpathSync(mkdtempSync(path.join(tmpdir(), "skills-import-")));
  agents = path.join(base, ".agents", "skills");
  claude = path.join(base, ".claude", "skills");
  skillsDir = path.join(base, "app", "skills");
  outside = path.join(base, "outside");
  write(path.join(outside, "id_rsa"), "PRIVATE KEY");

  write(path.join(agents, "notes", "SKILL.md"), md("notes"));
  write(path.join(agents, "notes", "scripts", "export.js"), "console.log(1)\n");
  write(path.join(agents, "notes", ".git", "HEAD"), "ref\n");
  symlinkSync(path.join(outside, "id_rsa"), path.join(agents, "notes", "scripts", "key"));
  write(path.join(agents, "zod-skill", "SKILL.md"), md("zod"));
  write(
    path.join(agents, "handoff", "SKILL.md"),
    md("handoff", "disable-model-invocation: true\n"),
  );
  write(path.join(agents, "broken", "SKILL.md"), "no frontmatter");
  mkdirSync(claude, { recursive: true });
  symlinkSync(path.join(agents, "notes"), path.join(claude, "notes"));
  symlinkSync(path.join(base, "nowhere"), path.join(claude, "dangling"));
  write(path.join(claude, "only-claude", "SKILL.md"), md("only-claude"));
});

const roots = () => [agents, claude];

describe("defaultImportRoots", () => {
  it("scans ~/.agents/skills then ~/.claude/skills", () => {
    expect(defaultImportRoots("/Users/me")).toEqual([
      "/Users/me/.agents/skills",
      "/Users/me/.claude/skills",
    ]);
  });
});

describe("scanImportable", () => {
  it("follows top-level links, dedupes by real path and reports each status", async () => {
    const found = await scanImportable(roots(), skillsDir);
    const byName = Object.fromEntries(found.map((c) => [c.name, c]));
    expect(found.map((c) => c.name)).toEqual(["broken", "handoff", "notes", "only-claude", "zod"]);
    expect(byName.notes).toMatchObject({
      source: path.join(agents, "notes"),
      foundAt: [path.join(agents, "notes"), path.join(claude, "notes")],
      status: "importable",
    });
    expect(byName.zod).toMatchObject({ status: "importable", error: null });
    expect(byName.handoff?.status).toBe("manualOnly");
    expect(byName.broken).toMatchObject({ status: "invalid", error: "missingFrontmatter" });
  });

  it("tells already-imported copies apart from same-name skills with different content", async () => {
    await importSkills({ sources: [path.join(agents, "notes")], roots: roots(), skillsDir });
    let notes = (await scanImportable(roots(), skillsDir)).find((c) => c.name === "notes");
    expect(notes?.status).toBe("imported");
    write(path.join(agents, "notes", "scripts", "export.js"), "console.log(2)\n");
    notes = (await scanImportable(roots(), skillsDir)).find((c) => c.name === "notes");
    expect(notes?.status).toBe("conflict");
  });

  it("returns nothing when the source folders do not exist", async () => {
    await expect(scanImportable(["/nonexistent/a", "/nonexistent/b"], skillsDir)).resolves.toEqual(
      [],
    );
  });
});

describe("importSkills", () => {
  it("copies a skill under its name, skipping hidden files and links that point elsewhere", async () => {
    const result = await importSkills({
      sources: [path.join(agents, "notes"), path.join(agents, "zod-skill")],
      roots: roots(),
      skillsDir,
    });
    expect(result).toEqual({
      imported: ["notes", "zod"],
      failed: [],
      skippedLinks: [{ name: "notes", paths: ["scripts/key"] }],
    });
    expect(readFileSync(path.join(skillsDir, "notes", "scripts", "export.js"), "utf8")).toBe(
      "console.log(1)\n",
    );
    expect(existsSync(path.join(skillsDir, "notes", "scripts", "key"))).toBe(false);
    expect(existsSync(path.join(skillsDir, "notes", ".git"))).toBe(false);
    expect(existsSync(path.join(skillsDir, "zod", "SKILL.md"))).toBe(true);
    expect(readdirSync(skillsDir).sort()).toEqual(["notes", "zod"]);
  });

  it("replaces an existing skill with the same name", async () => {
    await importSkills({ sources: [path.join(agents, "notes")], roots: roots(), skillsDir });
    write(path.join(skillsDir, "notes", "local-edit.txt"), "mine");
    write(path.join(agents, "notes", "scripts", "export.js"), "console.log(2)\n");
    const result = await importSkills({
      sources: [path.join(agents, "notes")],
      roots: roots(),
      skillsDir,
    });
    expect(result.imported).toEqual(["notes"]);
    expect(existsSync(path.join(skillsDir, "notes", "local-edit.txt"))).toBe(false);
    expect(readFileSync(path.join(skillsDir, "notes", "scripts", "export.js"), "utf8")).toBe(
      "console.log(2)\n",
    );
    expect(readdirSync(skillsDir)).toEqual(["notes"]);
  });

  it("refuses sources that are not importable scan results", async () => {
    const result = await importSkills({
      sources: [outside, path.join(agents, "handoff"), path.join(agents, "broken")],
      roots: roots(),
      skillsDir,
    });
    expect(result.imported).toEqual([]);
    expect(result.failed).toEqual([
      { name: "outside", reason: "notFound" },
      { name: "handoff", reason: "manualOnly" },
      { name: "broken", reason: "invalid" },
    ]);
  });

  it("rejects skills over the size cap and leaves no partial folder behind", async () => {
    write(path.join(agents, "notes", "big.bin"), "x".repeat(5000));
    const result = await importSkills({
      sources: [path.join(agents, "notes")],
      roots: roots(),
      skillsDir,
      maxBytes: 1000,
    });
    expect(result.failed).toEqual([{ name: "notes", reason: "tooLarge" }]);
    expect(readdirSync(skillsDir)).toEqual([]);
  });
});
