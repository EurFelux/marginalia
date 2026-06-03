// src/main/ai/assistant-model.test.ts
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { upsertProvider } from "@main/providers/repository";
import { getDefaultAssistant, updateDefaultAssistant } from "@main/providers/assistant";
import { resolveAssistantModel } from "@main/ai/assistant-model";
import { initMainI18n } from "@main/i18n";

beforeAll(() => initMainI18n("en"));

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const freshDb = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
};

function configure(db: ReturnType<typeof freshDb>) {
  const provider = upsertProvider(db, {
    type: "openai-responses",
    baseUrl: "https://api.openai.com/v1",
    apiKey: "sk-test",
  });
  updateDefaultAssistant(db, { providerId: provider.id, model: "gpt-4o-mini" });
  return provider;
}

describe("resolveAssistantModel", () => {
  it("resolves a model when assistant has a provider, model, and key", () => {
    const db = freshDb();
    configure(db);
    const r = resolveAssistantModel(db);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.modelId).toBe("gpt-4o-mini");
      expect(r.model).toBeDefined();
    }
  });

  it("fails when the assistant has no provider configured", () => {
    const db = freshDb();
    getDefaultAssistant(db); // seed default assistant (no provider/model)
    const r = resolveAssistantModel(db);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("provider") });
  });

  it("fails when the assistant has a provider but no model", () => {
    const db = freshDb();
    const provider = upsertProvider(db, {
      type: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
      apiKey: "sk",
    });
    updateDefaultAssistant(db, { providerId: provider.id });
    const r = resolveAssistantModel(db);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("model") });
  });

  it("fails when the provider has no API key", () => {
    const db = freshDb();
    const provider = upsertProvider(db, {
      type: "openai-responses",
      baseUrl: "https://api.openai.com/v1",
    });
    updateDefaultAssistant(db, { providerId: provider.id, model: "gpt-4o-mini" });
    const r = resolveAssistantModel(db);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("API key") });
  });
});
