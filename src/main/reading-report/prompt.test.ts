import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { createMemory } from "@main/memory/repository";
import { setPreference } from "@main/preferences/repository";
import { buildReadingReportSystemPrompt } from "@main/reading-report/prompt";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("buildReadingReportSystemPrompt", () => {
  it("writes as the configured assistant and places reader instructions last", () => {
    const db = freshDb();
    setPreference(db, "soul", { name: "Mia", persona: "Warm, precise, and curious." });
    setPreference(db, "instructions", "Use short titled sections.");
    createMemory(db, {
      slug: "systems-thinking",
      title: "Systems thinking",
      description: "The reader connects mechanisms across books.",
      body: "Stable context.",
    });

    const prompt = buildReadingReportSystemPrompt(db);

    expect(prompt).toContain("from your own first-person perspective as the assistant");
    expect(prompt).toContain("Your name is Mia. Warm, precise, and curious.");
    expect(prompt).toContain("[systems-thinking] Systems thinking");
    expect(prompt).toContain("Use short titled sections.");
    expect(prompt.indexOf("Use short titled sections.")).toBeGreaterThan(
      prompt.indexOf("from your own first-person perspective as the assistant"),
    );
    expect(prompt).not.toContain("in the reader's first person");
  });

  it("omits memory guidance and index when memory is disabled", () => {
    const db = freshDb();
    setPreference(db, "memoryEnabled", false);
    createMemory(db, {
      slug: "hidden",
      title: "Hidden",
      description: "Must not be injected.",
      body: "Hidden body.",
    });

    const prompt = buildReadingReportSystemPrompt(db);

    expect(prompt).not.toContain("## Memory index");
    expect(prompt).not.toContain("saveMemory");
    expect(prompt).not.toContain("[hidden]");
    expect(prompt).toContain("## Who you are");
  });
});
