import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { getAppMeta, setAppMeta } from "@main/app-meta/repository";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("app-meta repository", () => {
  it("returns null for an unset key", () => {
    const db = freshDb();
    expect(getAppMeta(db, "sampleSeeded")).toBeNull();
  });

  it("set then get round-trips the value", () => {
    const db = freshDb();
    setAppMeta(db, "sampleSeeded", true);
    expect(getAppMeta(db, "sampleSeeded")).toBe(true);
  });

  it("upsert overwrites an existing key", () => {
    const db = freshDb();
    setAppMeta(db, "sampleSeeded", true);
    setAppMeta(db, "sampleSeeded", false);
    expect(getAppMeta(db, "sampleSeeded")).toBe(false);
  });
});
