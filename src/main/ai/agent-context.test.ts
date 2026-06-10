import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { setPreference } from "@main/preferences/repository";
import { createMemory } from "@main/memory/repository";
import {
  dropAgentContext,
  getAgentContext,
  invalidateAllAgentContexts,
  renderAgentContext,
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
    createMemory(db, { slug: "m1", title: "T1", description: "D1", body: "b", sourceBookId: null });
    createMemory(db, { slug: "m2", title: "T2", description: "D2", body: "b", sourceBookId: null });
    const text = renderAgentContext(db);
    expect(text).toContain("be brief");
    expect(text.indexOf("[m1]")).toBeLessThan(text.indexOf("[m2]"));
    expect(text).toContain("[m1] T1 — D1");
  });

  it("omits memory index when memoryEnabled=false (soul still present)", () => {
    const db = freshDb();
    setPreference(db, "memoryEnabled", false);
    createMemory(db, { slug: "m1", title: "T1", description: "D1", body: "b", sourceBookId: null });
    const text = renderAgentContext(db);
    expect(text).not.toContain("[m1]");
    expect(text).toContain("Lia");
  });
});

describe("session snapshot freeze", () => {
  it("returns identical text within a conversation even after new memory", () => {
    const db = freshDb();
    const first = getAgentContext(db, "conv-1");
    createMemory(db, { slug: "new", title: "N", description: "D", body: "b", sourceBookId: null });
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
    createMemory(db, { slug: "late", title: "L", description: "D", body: "b", sourceBookId: null });
    expect(getAgentContext(db, "conv-1")).toContain("[late]");
  });

  it("memory index disappears after memoryEnabled flips off and contexts invalidated", () => {
    const db = freshDb();
    createMemory(db, { slug: "m", title: "T", description: "D", body: "b", sourceBookId: null });
    expect(getAgentContext(db, "conv-1")).toContain("[m]");
    setPreference(db, "memoryEnabled", false);
    invalidateAllAgentContexts();
    expect(getAgentContext(db, "conv-1")).not.toContain("[m]");
  });
});
