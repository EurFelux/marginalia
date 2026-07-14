import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, type DB } from "@main/db/client";
import { createMemory, getMemoryBySlug } from "@main/memory/repository";
import { setPreference } from "@main/preferences/repository";
import {
  createReadingReportMemoryWorkspace,
  type ReadingReportMemoryWorkspace,
} from "@main/reading-report/memory-workspace";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const toolOptions = { toolCallId: "report-memory", messages: [] } as never;

async function executeTool(workspace: ReadingReportMemoryWorkspace, name: string, input: unknown) {
  const candidate = workspace.tools[name];
  if (!candidate?.execute) throw new Error(`${name} tool missing`);
  return candidate.execute(input as never, toolOptions);
}

describe("createReadingReportMemoryWorkspace", () => {
  let db: DB;

  beforeEach(() => {
    db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
  });

  it("exposes only read, save, and update tools when memory is enabled", () => {
    const workspace = createReadingReportMemoryWorkspace(db);

    expect(Object.keys(workspace.tools).sort()).toEqual([
      "readMemory",
      "saveMemory",
      "updateMemory",
    ]);
  });

  it("stages saves and lets later reads observe the overlay without touching the database", async () => {
    const workspace = createReadingReportMemoryWorkspace(db);
    await executeTool(workspace, "saveMemory", {
      slug: "attention-pattern",
      title: "Attention pattern",
      description: "The reader follows changes in attention.",
      body: "Connected to [[systems-thinking]].",
    });

    const read = await executeTool(workspace, "readMemory", { slug: "attention-pattern" });

    expect(read).toEqual(expect.objectContaining({ found: true, body: expect.any(String) }));
    expect(getMemoryBySlug(db, "attention-pattern")).toBeNull();
    expect(workspace.mutations()).toEqual([
      expect.objectContaining({ kind: "create", slug: "attention-pattern" }),
    ]);
  });

  it("collapses repeated updates into one optimistic mutation", async () => {
    const existing = createMemory(db, {
      slug: "systems-thinking",
      title: "Systems thinking",
      description: "Old description.",
      body: "Old body.",
    });
    const workspace = createReadingReportMemoryWorkspace(db);

    await executeTool(workspace, "updateMemory", {
      slug: existing.slug,
      description: "New description.",
    });
    await executeTool(workspace, "updateMemory", {
      slug: existing.slug,
      body: "New body.",
    });

    expect(workspace.mutations()).toEqual([
      expect.objectContaining({
        kind: "update",
        id: existing.id,
        expectedUpdatedAt: existing.updatedAt,
        description: "New description.",
        body: "New body.",
      }),
    ]);
  });

  it("derives links from the staged overlay", async () => {
    createMemory(db, {
      slug: "systems-thinking",
      title: "Systems thinking",
      description: "A durable framework.",
      body: "Old body.",
    });
    const workspace = createReadingReportMemoryWorkspace(db);
    await executeTool(workspace, "saveMemory", {
      slug: "attention-pattern",
      title: "Attention pattern",
      description: "The reader follows attention.",
      body: "Uses [[systems-thinking]] and [[missing-memory]].",
    });
    await executeTool(workspace, "updateMemory", {
      slug: "systems-thinking",
      body: "Connects back to [[attention-pattern]].",
    });

    const read = (await executeTool(workspace, "readMemory", {
      slug: "attention-pattern",
    })) as {
      outgoing: Array<{ slug: string }>;
      incoming: Array<{ slug: string }>;
      danglingLinks: string[];
    };

    expect(read.outgoing.map((memory) => memory.slug)).toEqual(["systems-thinking"]);
    expect(read.incoming.map((memory) => memory.slug)).toEqual(["systems-thinking"]);
    expect(read.danglingLinks).toEqual(["missing-memory"]);
  });

  it("returns no tools or mutations when memory is disabled", () => {
    setPreference(db, "memoryEnabled", false);

    const workspace = createReadingReportMemoryWorkspace(db);

    expect(workspace.tools).toEqual({});
    expect(workspace.mutations()).toEqual([]);
  });
});
