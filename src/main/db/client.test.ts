import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { assistants, providers } from "@main/db/schema";

const MIGRATIONS = path.resolve(__dirname, "migrations");

describe("db client", () => {
  it("runs migrations and round-trips a provider with a uuidv7 id", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);

    db.insert(providers).values({ type: "openai", label: "test" }).run();

    const rows = db.select().from(providers).where(eq(providers.type, "openai")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("test");
    expect(rows[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("enforces foreign key constraints", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    expect(() =>
      db.insert(assistants).values({ name: "x", providerId: "nonexistent-id" }).run(),
    ).toThrow();
  });
});
