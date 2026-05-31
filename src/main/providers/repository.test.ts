import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import type { Encryptor } from "@main/secrets/encryptor";
import type { ProviderTester } from "@main/secrets/tester";
import {
  getProviderRow,
  listProviders,
  removeProvider,
  revealProviderKey,
  testProvider,
  upsertProvider,
} from "@main/providers/repository";
import {
  DEFAULT_ASSISTANT_NAME,
  getDefaultAssistant,
  updateDefaultAssistant,
} from "@main/providers/assistant";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
const freshDb = () => {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
};

// 可逆 fake：明文 utf8 ↔ buffer，足够验证存取与掩码。
const fakeEncryptor: Encryptor = {
  isAvailable: () => true,
  encrypt: (p) => Buffer.from(p, "utf8"),
  decrypt: (c) => c.toString("utf8"),
};
const unavailableEncryptor: Encryptor = {
  isAvailable: () => false,
  encrypt: () => {
    throw new Error("unavailable");
  },
  decrypt: () => {
    throw new Error("unavailable");
  },
};
const brokenDecryptEncryptor: Encryptor = {
  isAvailable: () => true,
  encrypt: (p) => Buffer.from(p, "utf8"),
  decrypt: () => {
    throw new Error("cannot decrypt");
  },
};
const okTester: ProviderTester = { test: async () => ({ ok: true }) };

describe("provider repository", () => {
  it("creates a provider with an encrypted key and exposes only a masked preview", () => {
    const db = freshDb();
    const dto = upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-abcdefghij" });
    expect(dto.type).toBe("openai");
    expect(dto.hasKey).toBe(true);
    expect(dto.keyDecryptable).toBe(true);
    expect(dto.keyMask).toBe("sk-…ghij");
    const row = getProviderRow(db, dto.id);
    expect(row?.apiKeyEncrypted).toBeInstanceOf(Buffer);
    expect(row?.apiKeyEncrypted?.toString("utf8")).toBe("sk-abcdefghij");
  });

  it("creates a provider without a key", () => {
    const db = freshDb();
    const dto = upsertProvider(db, fakeEncryptor, { type: "anthropic" });
    expect(dto.hasKey).toBe(false);
    expect(dto.keyMask).toBeNull();
    expect(dto.keyDecryptable).toBe(false);
  });

  it("update without apiKey keeps the existing key", () => {
    const db = freshDb();
    const created = upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-original99" });
    const updated = upsertProvider(db, fakeEncryptor, {
      id: created.id,
      type: "openai",
      label: "Renamed",
    });
    expect(updated.label).toBe("Renamed");
    expect(revealProviderKey(db, fakeEncryptor, created.id)).toBe("sk-original99");
  });

  it("update with apiKey replaces the key", () => {
    const db = freshDb();
    const created = upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-original99" });
    upsertProvider(db, fakeEncryptor, { id: created.id, type: "openai", apiKey: "sk-replaced77" });
    expect(revealProviderKey(db, fakeEncryptor, created.id)).toBe("sk-replaced77");
  });

  it("lists all providers", () => {
    const db = freshDb();
    upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-aaaaaaaa11" });
    upsertProvider(db, fakeEncryptor, { type: "anthropic", apiKey: "sk-bbbbbbbb22" });
    expect(listProviders(db, fakeEncryptor)).toHaveLength(2);
  });

  it("reveal returns the plaintext key; throws when no key", () => {
    const db = freshDb();
    const withKey = upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-secretkey1" });
    expect(revealProviderKey(db, fakeEncryptor, withKey.id)).toBe("sk-secretkey1");
    const noKey = upsertProvider(db, fakeEncryptor, { type: "openai" });
    expect(() => revealProviderKey(db, fakeEncryptor, noKey.id)).toThrow(/no API key/i);
  });

  it("refuses to store a key when secure storage is unavailable", () => {
    const db = freshDb();
    expect(() =>
      upsertProvider(db, unavailableEncryptor, { type: "openai", apiKey: "sk-whatever12" }),
    ).toThrow(/secure storage is unavailable/i);
  });

  it("marks keyDecryptable false (and keyMask null) when decryption fails", () => {
    const db = freshDb();
    const created = upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-abcdefghij" });
    const listed = listProviders(db, brokenDecryptEncryptor).find((p) => p.id === created.id);
    expect(listed?.hasKey).toBe(true);
    expect(listed?.keyDecryptable).toBe(false);
    expect(listed?.keyMask).toBeNull();
  });

  it("removeProvider deletes it and clears assistant references", () => {
    const db = freshDb();
    const prov = upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-abcdefghij" });
    getDefaultAssistant(db);
    updateDefaultAssistant(db, { providerId: prov.id });
    removeProvider(db, prov.id);
    expect(getProviderRow(db, prov.id)).toBeUndefined();
    expect(getDefaultAssistant(db).providerId).toBeNull();
    expect(getDefaultAssistant(db).name).toBe(DEFAULT_ASSISTANT_NAME);
  });

  it("removeProvider throws for a non-existent provider", () => {
    const db = freshDb();
    expect(() => removeProvider(db, "nope")).toThrow(/not found/i);
  });

  describe("testProvider", () => {
    it("throws when the provider does not exist", async () => {
      const db = freshDb();
      await expect(
        testProvider(db, fakeEncryptor, okTester, "nope", "gpt-4o-mini"),
      ).rejects.toThrow(/not found/i);
    });

    it("returns ok:false when the provider has no key", async () => {
      const db = freshDb();
      const noKey = upsertProvider(db, fakeEncryptor, { type: "openai" });
      const r = await testProvider(db, fakeEncryptor, okTester, noKey.id, "gpt-4o-mini");
      expect(r).toEqual({ ok: false, message: "No API key set for this provider" });
    });

    it("returns ok:false when the key cannot be decrypted", async () => {
      const db = freshDb();
      const p = upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-abcdefghij" });
      const r = await testProvider(db, brokenDecryptEncryptor, okTester, p.id, "gpt-4o-mini");
      expect(r.ok).toBe(false);
    });

    it("delegates to the tester with the decrypted key + model when valid", async () => {
      const db = freshDb();
      const p = upsertProvider(db, fakeEncryptor, { type: "openai", apiKey: "sk-abcdefghij" });
      let seen: { apiKey: string; model: string } | undefined;
      const spyTester: ProviderTester = {
        test: async (params) => {
          seen = { apiKey: params.apiKey, model: params.model };
          return { ok: true };
        },
      };
      const r = await testProvider(db, fakeEncryptor, spyTester, p.id, "gpt-4o-mini");
      expect(r).toEqual({ ok: true });
      expect(seen).toEqual({ apiKey: "sk-abcdefghij", model: "gpt-4o-mini" });
    });
  });
});
