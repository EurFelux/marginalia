import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { getPreference, setPreference } from "@main/preferences/repository";
import { createMemory, getMemoryBySlug } from "@main/memory/repository";
import { createMemoryTools } from "@main/ai/memory-tools";
import { DEFAULT_SOUL } from "@shared/preferences";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("createMemoryTools", () => {
  it("omits memory tools when memoryEnabled=false but always exposes updateSoul", () => {
    const db = freshDb();
    setPreference(db, "memoryEnabled", false);
    const tools = createMemoryTools({ db, bookId: "b1" });
    expect(Object.keys(tools)).toEqual(["updateSoul"]);
  });

  it("saveMemory fills sourceBookId from deps and returns the slug", async () => {
    const db = freshDb();
    const tools = createMemoryTools({ db, bookId: null });
    if (!tools.saveMemory) throw new Error("expected full toolset");
    const out = await tools.saveMemory.execute!(
      { slug: "econ", title: "T", description: "D", body: "B" },
      {} as never,
    );
    expect(out).toMatchObject({ saved: true, slug: "econ" });
    expect(getMemoryBySlug(db, "econ")).not.toBeNull();
  });

  it("saveMemory reports slug conflict as tool result (model self-corrects)", async () => {
    const db = freshDb();
    createMemory(db, { slug: "dup", title: "t", description: "d", body: "b", sourceBookId: null });
    const tools = createMemoryTools({ db, bookId: null });
    if (!tools.saveMemory) throw new Error("expected full toolset");
    const out = await tools.saveMemory.execute!(
      { slug: "dup", title: "T", description: "D", body: "B" },
      {} as never,
    );
    expect(out).toMatchObject({ saved: false });
  });

  it("readMemory returns body with outgoing/incoming/dangling; unknown slug returns notFound", async () => {
    const db = freshDb();
    createMemory(db, {
      slug: "a",
      title: "A",
      description: "d",
      body: "see [[ghost]]",
      sourceBookId: null,
    });
    const tools = createMemoryTools({ db, bookId: null });
    if (!tools.readMemory) throw new Error("expected full toolset");
    const ok = await tools.readMemory.execute!({ slug: "a" }, {} as never);
    expect(ok).toMatchObject({ found: true, danglingLinks: ["ghost"] });
    const miss = await tools.readMemory.execute!({ slug: "nope" }, {} as never);
    expect(miss).toMatchObject({ found: false });
  });

  it("updateMemory / deleteMemory operate by slug; unknown slug self-correct result", async () => {
    const db = freshDb();
    createMemory(db, { slug: "m", title: "t", description: "d", body: "b", sourceBookId: null });
    const tools = createMemoryTools({ db, bookId: null });
    if (!tools.updateMemory || !tools.deleteMemory) throw new Error("expected full toolset");
    const upd = await tools.updateMemory.execute!({ slug: "m", title: "t2" }, {} as never);
    expect(upd).toMatchObject({ updated: true });
    const del = await tools.deleteMemory.execute!({ slug: "m" }, {} as never);
    expect(del).toMatchObject({ deleted: true });
    const miss = await tools.deleteMemory.execute!({ slug: "m" }, {} as never);
    expect(miss).toMatchObject({ deleted: false });
  });

  it("updateSoul patches name/persona and invalidates snapshots", async () => {
    const db = freshDb();
    const tools = createMemoryTools({ db, bookId: null });
    const out = await tools.updateSoul!.execute!({ name: "Mia" }, {} as never);
    expect(out).toMatchObject({ updated: true });
    expect(getPreference(db, "soul")?.name).toBe("Mia");
    expect(getPreference(db, "soul")?.persona).toBe(DEFAULT_SOUL.persona);
  });
});
