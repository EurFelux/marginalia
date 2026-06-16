import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { createMemory } from "@main/memory/repository";
import { setPreference } from "@main/preferences/repository";
import { invalidateAllAgentContexts } from "@main/ai/agent-context";
import {
  BASE_SYSTEM_PROMPT,
  LIBRARY_SYSTEM_PROMPT,
  LIBRARY_TOOLS_FRAGMENT,
  buildSystemPrompt,
} from "@main/ai/base-prompt";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

beforeEach(() => invalidateAllAgentContexts());

describe("buildSystemPrompt", () => {
  it("starts with base template and appends agent context", () => {
    const db = freshDb();
    createMemory(db, { slug: "m", title: "T", description: "D", body: "b", sourceBookId: null });
    const text = buildSystemPrompt(db, "conv-1");
    expect(text.startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
    expect(text).toContain("[m] T — D");
  });

  it("is verbatim-stable across turns of the same conversation", () => {
    const db = freshDb();
    const a = buildSystemPrompt(db, "conv-1");
    createMemory(db, { slug: "m2", title: "T", description: "D", body: "b", sourceBookId: null });
    expect(buildSystemPrompt(db, "conv-1")).toBe(a);
  });

  it("omits memory guidance when memoryEnabled=false", () => {
    const db = freshDb();
    setPreference(db, "memoryEnabled", false);
    const text = buildSystemPrompt(db, "conv-1");
    expect(text).not.toContain("## Memory guidance");
    expect(text).toContain("reading companion"); // base 模板仍在
  });
});

describe("buildSystemPrompt — library kind", () => {
  it("uses the librarian base when kind=library", () => {
    const db = freshDb();
    const text = buildSystemPrompt(db, "conv-lib", "library");
    expect(text.startsWith(LIBRARY_SYSTEM_PROMPT)).toBe(true);
    // Must not use the book-reader base template
    expect(text.startsWith(BASE_SYSTEM_PROMPT)).toBe(false);
  });
  it("defaults to the reading-companion base (book) when kind omitted", () => {
    const db = freshDb();
    expect(buildSystemPrompt(db, "conv-book").startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
  });
});

describe("buildSystemPrompt — book kind library tools", () => {
  it("appends the shared library tools fragment to the reading-companion base", () => {
    const db = freshDb();
    const text = buildSystemPrompt(db, "conv-book"); // kind 默认 book
    expect(text.startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
    expect(text).toContain(LIBRARY_TOOLS_FRAGMENT);
    expect(text).toContain("listBooks");
  });

  it("library kind reuses the same fragment (single source of truth)", () => {
    const db = freshDb();
    const text = buildSystemPrompt(db, "conv-lib", "library");
    expect(text).toContain(LIBRARY_TOOLS_FRAGMENT);
  });
});
