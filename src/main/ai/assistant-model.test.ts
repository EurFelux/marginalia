// src/main/ai/assistant-model.test.ts
import path from "node:path";
import { beforeAll, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { upsertProvider } from "@main/providers/repository";
import { resolveSummaryModel, resolveChatModel } from "@main/ai/assistant-model";
import { initMainI18n } from "@main/i18n";
import { setPreference } from "@main/preferences/repository";

beforeAll(() => initMainI18n("en"));

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const freshDb = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
};

describe("resolveChatModel", () => {
  it("returns structured error when chatModel preference missing", () => {
    const db = freshDb();
    const r = resolveChatModel(db);
    expect(r.ok).toBe(false);
  });

  it("resolves model from chatModel preference", () => {
    const db = freshDb();
    const provider = upsertProvider(db, {
      type: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
      apiKey: "k",
    });
    setPreference(db, "chatModel", { providerId: provider.id, model: "claude-x" });
    const r = resolveChatModel(db);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.modelId).toBe("claude-x");
  });

  it("fails when the preference points at a non-existent provider", () => {
    const db = freshDb();
    setPreference(db, "chatModel", { providerId: "ghost", model: "m" });
    const r = resolveChatModel(db);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("not found") });
  });

  it("fails when the provider has no API key", () => {
    const db = freshDb();
    const provider = upsertProvider(db, {
      type: "anthropic",
      baseUrl: "https://api.anthropic.com/v1",
    });
    setPreference(db, "chatModel", { providerId: provider.id, model: "m" });
    const r = resolveChatModel(db);
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
    if (r.ok) {
      expect(r.modelId).toBe("claude-haiku-4-5");
      expect(r.providerType).toBe("anthropic");
    }
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
