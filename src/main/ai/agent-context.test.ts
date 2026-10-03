import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { appService } from "@main/app";
import { createDb, runMigrations } from "@main/db/client";
import { setPreference } from "@main/preferences/repository";
import { createMemory } from "@main/memory/repository";
import {
  dropAgentContext,
  enabledSkills,
  getAgentContext,
  invalidateAllAgentContexts,
  renderAssistantIdentity,
  renderAgentContext,
  renderMemoryIndex,
  renderReaderInstructions,
  renderSkillsIndex,
} from "@main/ai/agent-context";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

beforeEach(() => invalidateAllAgentContexts());

describe("renderAgentContext", () => {
  it("renders default soul when nothing stored; omits instructions and memory sections when empty", () => {
    const db = freshDb();
    const text = renderAgentContext(db);
    expect(text).toContain("Lia");
    expect(text).not.toContain("## Reader instructions");
    expect(text).not.toContain("## Memory index");
  });

  it("renders instructions and memory index lines in (createdAt, id) order", () => {
    const db = freshDb();
    setPreference(db, "instructions", "be brief");
    createMemory(db, { slug: "m1", title: "T1", description: "D1", body: "b" });
    createMemory(db, { slug: "m2", title: "T2", description: "D2", body: "b" });
    const text = renderAgentContext(db);
    expect(text).toContain("be brief");
    expect(text.indexOf("[m1]")).toBeLessThan(text.indexOf("[m2]"));
    expect(text).toContain("[m1] T1 — D1");
    expect(text).toBe(
      [renderReaderInstructions(db), renderAssistantIdentity(db), renderMemoryIndex(db)]
        .filter((section): section is string => section !== null)
        .join("\n\n"),
    );
  });

  it("omits memory index when memoryEnabled=false (soul still present)", () => {
    const db = freshDb();
    setPreference(db, "memoryEnabled", false);
    createMemory(db, { slug: "m1", title: "T1", description: "D1", body: "b" });
    const text = renderAgentContext(db);
    expect(text).not.toContain("[m1]");
    expect(text).toContain("Lia");
  });
});

describe("session snapshot freeze", () => {
  it("returns identical text within a conversation even after new memory", () => {
    const db = freshDb();
    const first = getAgentContext(db, "conv-1");
    createMemory(db, { slug: "new", title: "N", description: "D", body: "b" });
    expect(getAgentContext(db, "conv-1")).toBe(first); // 冻结：逐字一致
    expect(getAgentContext(db, "conv-2")).toContain("[new]"); // 新会话见新记忆
  });

  it("invalidateAllAgentContexts forces re-render (soul/instructions change semantics)", () => {
    const db = freshDb();
    const first = getAgentContext(db, "conv-1");
    setPreference(db, "soul", { name: "Mia", persona: "p" });
    invalidateAllAgentContexts();
    const second = getAgentContext(db, "conv-1");
    expect(second).not.toBe(first);
    expect(second).toContain("Mia");
  });

  it("dropAgentContext clears a single conversation snapshot", () => {
    const db = freshDb();
    getAgentContext(db, "conv-1");
    dropAgentContext("conv-1");
    createMemory(db, { slug: "late", title: "L", description: "D", body: "b" });
    expect(getAgentContext(db, "conv-1")).toContain("[late]");
  });

  it("memory index disappears after memoryEnabled flips off and contexts invalidated", () => {
    const db = freshDb();
    createMemory(db, { slug: "m", title: "T", description: "D", body: "b" });
    expect(getAgentContext(db, "conv-1")).toContain("[m]");
    setPreference(db, "memoryEnabled", false);
    invalidateAllAgentContexts();
    expect(getAgentContext(db, "conv-1")).not.toContain("[m]");
  });
});

describe("skills index", () => {
  const skillsDir = appService.getPath("skillsDir");
  const addSkill = (name: string, description: string, extra = "") => {
    mkdirSync(path.join(skillsDir, name), { recursive: true });
    writeFileSync(
      path.join(skillsDir, name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${description}\n${extra}---\n\nBody\n`,
    );
  };

  beforeEach(() => rmSync(skillsDir, { recursive: true, force: true }));
  afterAll(() => rmSync(skillsDir, { recursive: true, force: true }));

  it("is omitted when there are no skills", () => {
    expect(renderSkillsIndex([])).toBeNull();
    expect(renderAgentContext(freshDb())).not.toContain("## Skills");
  });

  it("lists enabled, model-invocable skills with one-line descriptions", () => {
    addSkill("export-notes", "|\n  Export notes\n  to Obsidian.");
    addSkill("handoff", "Manual only", "disable-model-invocation: true\n");
    addSkill("zz-off", "Disabled one");
    const db = freshDb();
    setPreference(db, "disabledSkills", ["zz-off"]);
    const text = renderAgentContext(db);
    expect(text).toContain("## Skills");
    expect(text).toContain("call loadSkill with its name");
    expect(text).toContain("- export-notes: Export notes to Obsidian.");
    expect(text).not.toContain("handoff");
    expect(text).not.toContain("zz-off");
    expect(enabledSkills(db).map((s) => s.name)).toEqual(["export-notes"]);
  });

  it("stays frozen in a conversation's snapshot until invalidated", () => {
    const db = freshDb();
    expect(getAgentContext(db, "c-skills")).not.toContain("## Skills");
    addSkill("late", "Added mid-conversation");
    expect(getAgentContext(db, "c-skills")).not.toContain("late");
    invalidateAllAgentContexts();
    expect(getAgentContext(db, "c-skills")).toContain("- late: Added mid-conversation");
  });
});
