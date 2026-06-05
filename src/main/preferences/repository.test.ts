import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { preferences } from "@main/db/schema";
import { getAllPreferences, getPreference, setPreference } from "@main/preferences/repository";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("preferences repository", () => {
  it("round-trips each known key", () => {
    const db = freshDb();
    setPreference(db, "readerPrefs", {
      fontScale: 1.2,
      lineHeight: 2,
      maxWidth: 720,
      fontFamily: "default",
    });
    setPreference(db, "lastHighlightStyle", "green");
    setPreference(db, "autoSummarize", true);
    expect(getPreference(db, "readerPrefs")).toEqual({
      fontScale: 1.2,
      lineHeight: 2,
      maxWidth: 720,
      fontFamily: "default",
    });
    expect(getPreference(db, "lastHighlightStyle")).toBe("green");
    expect(getPreference(db, "autoSummarize")).toBe(true);
  });

  it("round-trips colorMode", () => {
    const db = freshDb();
    setPreference(db, "colorMode", "dark");
    expect(getPreference(db, "colorMode")).toBe("dark");
    expect(getAllPreferences(db)).toEqual({ colorMode: "dark" });
  });

  it("returns null for an unset key", () => {
    const db = freshDb();
    expect(getPreference(db, "autoSummarize")).toBeNull();
    expect(getPreference(db, "readerPrefs")).toBeNull();
  });

  it("upserts: a second set overwrites the value", () => {
    const db = freshDb();
    setPreference(db, "lastHighlightStyle", "yellow");
    setPreference(db, "lastHighlightStyle", "pink");
    expect(getPreference(db, "lastHighlightStyle")).toBe("pink");
    // 仅一行（key 主键，upsert 而非 insert）
    expect(db.select().from(preferences).all()).toHaveLength(1);
  });

  it("returns null (does not throw) when stored JSON no longer matches the schema", () => {
    const db = freshDb();
    // 直插一条不合 readerPrefs schema 的陈旧/损坏值
    db.insert(preferences)
      .values({ key: "readerPrefs", value: "not-an-object", updatedAt: 1 })
      .run();
    expect(getPreference(db, "readerPrefs")).toBeNull();
  });

  it("throws when setting a value that fails the key's schema", () => {
    const db = freshDb();
    // @ts-expect-error 故意传非法值以验运行时校验
    expect(() => setPreference(db, "readerPrefs", { fontScale: 1 })).toThrow();
    // @ts-expect-error 非法枚举值
    expect(() => setPreference(db, "lastHighlightStyle", "teal")).toThrow();
  });

  it("getAllPreferences returns every set & valid key, skipping corrupt/unknown", () => {
    const db = freshDb();
    setPreference(db, "autoSummarize", false);
    setPreference(db, "readerPrefs", {
      fontScale: 1,
      lineHeight: 1.9,
      maxWidth: 640,
      fontFamily: "default",
    });
    // 损坏的 lastHighlightStyle + 注册表外的陈旧 key 都应被跳过
    db.insert(preferences).values({ key: "lastHighlightStyle", value: 123, updatedAt: 1 }).run();
    db.insert(preferences).values({ key: "legacyKey", value: "x", updatedAt: 1 }).run();
    expect(getAllPreferences(db)).toEqual({
      autoSummarize: false,
      readerPrefs: { fontScale: 1, lineHeight: 1.9, maxWidth: 640, fontFamily: "default" },
    });
  });

  it("getAllPreferences is empty on a fresh db", () => {
    expect(getAllPreferences(freshDb())).toEqual({});
  });

  it("roundtrips the summaryModel preference", () => {
    const db = freshDb();
    setPreference(db, "summaryModel", { providerId: "p1", model: "claude-haiku-4-5" });
    expect(getPreference(db, "summaryModel")).toEqual({
      providerId: "p1",
      model: "claude-haiku-4-5",
    });
    expect(getAllPreferences(db)).toEqual({
      summaryModel: { providerId: "p1", model: "claude-haiku-4-5" },
    });
  });

  it("refreshes updatedAt on overwrite", () => {
    const db = freshDb();
    setPreference(db, "autoSummarize", true);
    db.update(preferences).set({ updatedAt: 1 }).where(eq(preferences.key, "autoSummarize")).run();
    setPreference(db, "autoSummarize", false);
    const row = db.select().from(preferences).where(eq(preferences.key, "autoSummarize")).get();
    expect(row?.updatedAt).toBeGreaterThan(1);
  });
});
