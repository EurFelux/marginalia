import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { providers } from "@main/db/schema";
import {
  DEFAULT_ASSISTANT_NAME,
  getDefaultAssistant,
  updateDefaultAssistant,
} from "@main/providers/assistant";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const UUID_V7_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const freshDb = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
};

describe("default assistant", () => {
  it("seeds a default assistant on first read", () => {
    const db = freshDb();
    const a = getDefaultAssistant(db);
    expect(a.name).toBe(DEFAULT_ASSISTANT_NAME);
    expect(a.systemPrompt).toBeTruthy();
    expect(a.id).toMatch(UUID_V7_RE);
  });

  it("returns the same row on subsequent reads (no duplicate seed)", () => {
    const db = freshDb();
    const a1 = getDefaultAssistant(db);
    const a2 = getDefaultAssistant(db);
    expect(a2.id).toBe(a1.id);
  });

  it("updates only the provided fields", () => {
    const db = freshDb();
    const before = getDefaultAssistant(db);
    const after = updateDefaultAssistant(db, { name: "My Reader", model: "gpt-4o" });
    expect(after.name).toBe("My Reader");
    expect(after.model).toBe("gpt-4o");
    expect(after.systemPrompt).toBe(before.systemPrompt);
  });

  it("rejects setting providerId to a non-existent provider", () => {
    const db = freshDb();
    getDefaultAssistant(db);
    expect(() => updateDefaultAssistant(db, { providerId: "nope" })).toThrow(/not found/i);
  });

  it("accepts a valid providerId and can unset it with null", () => {
    const db = freshDb();
    const prov = db.insert(providers).values({ type: "openai-responses" }).returning().get();
    getDefaultAssistant(db);
    expect(updateDefaultAssistant(db, { providerId: prov.id }).providerId).toBe(prov.id);
    expect(updateDefaultAssistant(db, { providerId: null }).providerId).toBeNull();
  });

  it("updateDefaultAssistant materializes the default row when called before any read", () => {
    const db = freshDb();
    const a = updateDefaultAssistant(db, { name: "Materialized" });
    expect(a.name).toBe("Materialized");
    expect(a.id).toMatch(UUID_V7_RE);
    // 后续读取应拿到同一条记录
    expect(getDefaultAssistant(db).id).toBe(a.id);
  });
});
