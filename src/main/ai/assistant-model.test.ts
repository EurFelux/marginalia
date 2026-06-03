// src/main/ai/assistant-model.test.ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import type { Encryptor } from "@main/secrets/encryptor";
import { upsertProvider } from "@main/providers/repository";
import { getDefaultAssistant, updateDefaultAssistant } from "@main/providers/assistant";
import { resolveAssistantModel } from "@main/ai/assistant-model";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const freshDb = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
};

const fakeEncryptor: Encryptor = {
  isAvailable: () => true,
  encrypt: (p) => Buffer.from(p, "utf8"),
  decrypt: (c) => c.toString("utf8"),
};
const brokenDecrypt: Encryptor = {
  isAvailable: () => true,
  encrypt: (p) => Buffer.from(p, "utf8"),
  decrypt: () => {
    throw new Error("nope");
  },
};
const unavailableEncryptor: Encryptor = {
  isAvailable: () => false,
  encrypt: (p) => Buffer.from(p, "utf8"),
  decrypt: (c) => c.toString("utf8"),
};

function configure(db: ReturnType<typeof freshDb>) {
  const provider = upsertProvider(db, fakeEncryptor, {
    type: "openai-responses",
    apiKey: "sk-test",
  });
  updateDefaultAssistant(db, { providerId: provider.id, model: "gpt-4o-mini" });
  return provider;
}

describe("resolveAssistantModel", () => {
  it("resolves a model when assistant has a provider, model, and decryptable key", () => {
    const db = freshDb();
    configure(db);
    const r = resolveAssistantModel(db, fakeEncryptor);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.modelId).toBe("gpt-4o-mini");
      expect(r.model).toBeDefined();
    }
  });

  it("fails when the assistant has no provider configured", () => {
    const db = freshDb();
    getDefaultAssistant(db); // seed default assistant (no provider/model)
    const r = resolveAssistantModel(db, fakeEncryptor);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("provider") });
  });

  it("fails when the assistant has a provider but no model", () => {
    const db = freshDb();
    const provider = upsertProvider(db, fakeEncryptor, { type: "openai-responses", apiKey: "sk" });
    updateDefaultAssistant(db, { providerId: provider.id });
    const r = resolveAssistantModel(db, fakeEncryptor);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("model") });
  });

  it("fails when the provider has no API key", () => {
    const db = freshDb();
    const provider = upsertProvider(db, fakeEncryptor, { type: "openai-responses" });
    updateDefaultAssistant(db, { providerId: provider.id, model: "gpt-4o-mini" });
    const r = resolveAssistantModel(db, fakeEncryptor);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("API key") });
  });

  it("fails when the stored key cannot be decrypted on this machine", () => {
    const db = freshDb();
    configure(db);
    const r = resolveAssistantModel(db, brokenDecrypt);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("decrypt") });
  });

  it("fails when secure storage is unavailable", () => {
    const db = freshDb();
    configure(db);
    const r = resolveAssistantModel(db, unavailableEncryptor);
    expect(r).toMatchObject({ ok: false, reason: expect.stringContaining("secure storage") });
  });
});
