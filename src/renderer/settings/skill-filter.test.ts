import { describe, expect, it } from "vitest";
import { filterSkills } from "@renderer/settings/skill-filter";

const items = [
  { name: "zod", description: "Zod v4 best practices for schema validation" },
  { name: "export-notes", description: "Export highlights to Obsidian" },
  { name: "obsidian-sync", description: "Keep a vault in sync" },
];
const names = (q: string) => filterSkills(items, q).map((i) => i.name);

describe("filterSkills", () => {
  it("returns everything for an empty or blank query", () => {
    expect(names("")).toEqual(["zod", "export-notes", "obsidian-sync"]);
    expect(names("   ")).toEqual(["zod", "export-notes", "obsidian-sync"]);
  });

  it("matches names and descriptions case-insensitively", () => {
    expect(names("OBSIDIAN")).toEqual(["export-notes", "obsidian-sync"]);
    expect(names("schema")).toEqual(["zod"]);
  });

  it("requires every term to match", () => {
    expect(names("obsidian export")).toEqual(["export-notes"]);
    expect(names("obsidian nothing")).toEqual([]);
  });
});
