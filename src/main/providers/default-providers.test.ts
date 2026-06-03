import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { providers } from "@main/db/schema";
import { DEFAULT_PROVIDERS, seedDefaultProviders } from "@main/providers/default-providers";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("seedDefaultProviders", () => {
  it("seeds the defaults into an empty table", () => {
    const db = freshDb();
    seedDefaultProviders(db);
    const rows = db.select().from(providers).all();
    expect(rows).toHaveLength(DEFAULT_PROVIDERS.length);
    const byType = Object.fromEntries(rows.map((r) => [r.type, r]));
    expect(byType.openai.label).toBe("OpenAI");
    expect(byType.openai.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(byType.openai.apiKeyEncrypted).toBeNull();
    expect(byType.openai.baseUrl).toBeNull();
    expect(byType.anthropic.type).toBe("anthropic");
    expect(byType.google.label).toBe("Gemini");
  });

  it("is a no-op when the table is non-empty", () => {
    const db = freshDb();
    db.insert(providers).values({ type: "openai", label: "mine" }).run();
    seedDefaultProviders(db);
    expect(db.select().from(providers).all()).toHaveLength(1);
  });
});
