// src/main/ai/assistant-model.test.ts
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { upsertProvider } from "@main/providers/repository";
import { getDefaultAssistant, updateDefaultAssistant } from "@main/providers/assistant";
import { resolveAssistantModel, resolveSummaryModel } from "@main/ai/assistant-model";
import { initMainI18n } from "@main/i18n";
import { setPreference } from "@main/preferences/repository";

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

  it("exposes providerType on successful resolution", () => {
    const db = freshDb();
    configure(db);
    const resolved = resolveAssistantModel(db);
    expect(resolved.ok).toBe(true);
    expect(resolved.ok && resolved.providerType).toBe("openai-responses");
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

describe("resolveSummaryModel", () => {
  it("resolves when the preference points at a provider with a key", () => {
    const db = freshDb();
    const provider = upsertProvider(db, {
      type: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "sk-test",
    });
    setPreference(db, "summaryModel", { providerId: provider.id, model: "claude-haiku-4-5" });
    const r = resolveSummaryModel(db);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.modelId).toBe("claude-haiku-4-5");
  });

  it("fails when the preference is unset", () => {
    const db = freshDb();
    const r = resolveSummaryModel(db);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("Summary model") });
  });

  it("fails when the preference points at a non-existent provider", () => {
    const db = freshDb();
    setPreference(db, "summaryModel", { providerId: "ghost", model: "m" });
    const r = resolveSummaryModel(db);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("not found") });
  });

  it("fails when the provider has no API key", () => {
    const db = freshDb();
    const provider = upsertProvider(db, {
      type: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
    });
    setPreference(db, "summaryModel", { providerId: provider.id, model: "m" });
    const r = resolveSummaryModel(db);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("API key") });
  });
});
