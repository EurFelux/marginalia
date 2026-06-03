import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { providers } from "@main/db/schema";
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
    const dto = upsertProvider(db, fakeEncryptor, {
      type: "openai-responses",
      apiKey: "sk-abcdefghij",
    });
    expect(dto.type).toBe("openai-responses");
    expect(dto.key).toEqual({ status: "set", mask: "sk-…ghij" });
    const row = getProviderRow(db, dto.id);
    expect(row?.apiKeyEncrypted).toBeInstanceOf(Buffer);
    expect(row?.apiKeyEncrypted?.toString("utf8")).toBe("sk-abcdefghij");
    // DTO 绝不暴露密文或明文字段
    expect(dto).not.toHaveProperty("apiKeyEncrypted");
    expect(dto).not.toHaveProperty("apiKey");
    expect(dto.createdAt).toBeGreaterThan(0);
  });

  it("creates a provider without a key", () => {
    const db = freshDb();
    const dto = upsertProvider(db, fakeEncryptor, { type: "anthropic" });
    expect(dto.key).toEqual({ status: "none" });
  });

  it("update without apiKey keeps the existing key", () => {
    const db = freshDb();
    const created = upsertProvider(db, fakeEncryptor, {
      type: "openai-responses",
      apiKey: "sk-original99",
    });
    const updated = upsertProvider(db, fakeEncryptor, {
      id: created.id,
      type: "openai-responses",
      label: "Renamed",
    });
    expect(updated.label).toBe("Renamed");
    expect(revealProviderKey(db, fakeEncryptor, created.id)).toBe("sk-original99");
  });

  it("update preserves baseUrl/label when those fields are omitted", () => {
    const db = freshDb();
    const created = upsertProvider(db, fakeEncryptor, {
      type: "openai-responses",
      baseUrl: "https://custom.example/v1",
      label: "Original",
      apiKey: "sk-abcdefghij",
    });
    const updated = upsertProvider(db, fakeEncryptor, {
      id: created.id,
      type: "openai-responses",
      label: "Renamed",
    });
    expect(updated.label).toBe("Renamed");
    expect(updated.baseUrl).toBe("https://custom.example/v1"); // 未传入 baseUrl，不应被覆盖
  });

  it("update with apiKey replaces the key", () => {
    const db = freshDb();
    const created = upsertProvider(db, fakeEncryptor, {
      type: "openai-responses",
      apiKey: "sk-original99",
    });
    upsertProvider(db, fakeEncryptor, {
      id: created.id,
      type: "openai-responses",
      apiKey: "sk-replaced77",
    });
    expect(revealProviderKey(db, fakeEncryptor, created.id)).toBe("sk-replaced77");
  });

  it("lists all providers", () => {
    const db = freshDb();
    upsertProvider(db, fakeEncryptor, { type: "openai-responses", apiKey: "sk-aaaaaaaa11" });
    upsertProvider(db, fakeEncryptor, { type: "anthropic", apiKey: "sk-bbbbbbbb22" });
    expect(listProviders(db, fakeEncryptor)).toHaveLength(2);
  });

  it("reveal returns the plaintext key; throws when no key", () => {
    const db = freshDb();
    const withKey = upsertProvider(db, fakeEncryptor, {
      type: "openai-responses",
      apiKey: "sk-secretkey1",
    });
    expect(revealProviderKey(db, fakeEncryptor, withKey.id)).toBe("sk-secretkey1");
    const noKey = upsertProvider(db, fakeEncryptor, { type: "openai-responses" });
    expect(() => revealProviderKey(db, fakeEncryptor, noKey.id)).toThrow(/no API key/i);
  });

  it("refuses to store a key when secure storage is unavailable", () => {
    const db = freshDb();
    expect(() =>
      upsertProvider(db, unavailableEncryptor, {
        type: "openai-responses",
        apiKey: "sk-whatever12",
      }),
    ).toThrow(/secure storage is unavailable/i);
  });

  it("reports key status 'undecryptable' when decryption fails", () => {
    const db = freshDb();
    const created = upsertProvider(db, fakeEncryptor, {
      type: "openai-responses",
      apiKey: "sk-abcdefghij",
    });
    const listed = listProviders(db, brokenDecryptEncryptor).find((p) => p.id === created.id);
    expect(listed?.key).toEqual({ status: "undecryptable" });
  });

  it("removeProvider deletes it and clears assistant references", () => {
    const db = freshDb();
    const prov = upsertProvider(db, fakeEncryptor, {
      type: "openai-responses",
      apiKey: "sk-abcdefghij",
    });
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

  it("removeProvider only clears assistant refs to the removed provider", () => {
    const db = freshDb();
    const provA = upsertProvider(db, fakeEncryptor, {
      type: "openai-responses",
      apiKey: "sk-aaaaaaaa11",
    });
    const provB = upsertProvider(db, fakeEncryptor, { type: "anthropic", apiKey: "sk-bbbbbbbb22" });
    getDefaultAssistant(db);
    updateDefaultAssistant(db, { providerId: provA.id });
    removeProvider(db, provB.id);
    expect(getDefaultAssistant(db).providerId).toBe(provA.id); // A 的绑定不受影响
    expect(getProviderRow(db, provB.id)).toBeUndefined();
  });

  it("upsert sets models; omit preserves; [] clears; toDto returns [] for null", () => {
    const db = freshDb();
    const enc = fakeEncryptor;
    const a = upsertProvider(db, enc, { type: "openai-responses", models: ["gpt-4o"] });
    expect(a.models).toEqual(["gpt-4o"]);
    const b = upsertProvider(db, enc, { id: a.id, type: "openai-responses" }); // 省略 models
    expect(b.models).toEqual(["gpt-4o"]); // 保留
    const c = upsertProvider(db, enc, { id: a.id, type: "openai-responses", models: [] }); // 清空
    expect(c.models).toEqual([]);
    const d = upsertProvider(db, enc, { type: "anthropic" });
    expect(d.models).toEqual([]); // 新建省略 → []
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
      const noKey = upsertProvider(db, fakeEncryptor, { type: "openai-responses" });
      const r = await testProvider(db, fakeEncryptor, okTester, noKey.id, "gpt-4o-mini");
      expect(r).toEqual({ ok: false, message: "No API key set for this provider" });
    });

    it("returns ok:false when the key cannot be decrypted", async () => {
      const db = freshDb();
      const p = upsertProvider(db, fakeEncryptor, {
        type: "openai-responses",
        apiKey: "sk-abcdefghij",
      });
      const r = await testProvider(db, brokenDecryptEncryptor, okTester, p.id, "gpt-4o-mini");
      expect(r).toEqual({
        ok: false,
        message: "Stored API key cannot be decrypted on this machine",
      });
    });

    it("delegates to the tester with the full provider config + model, and the result leaks no plaintext", async () => {
      const db = freshDb();
      const p = upsertProvider(db, fakeEncryptor, {
        type: "openai-chat-completions",
        baseUrl: "http://localhost:1234/v1",
        apiKey: "sk-abcdefghij",
      });
      let seen: { type: string; baseUrl: string | null; apiKey: string; model: string } | undefined;
      const spyTester: ProviderTester = {
        test: async (params) => {
          seen = {
            type: params.type,
            baseUrl: params.baseUrl,
            apiKey: params.apiKey,
            model: params.model,
          };
          return { ok: true };
        },
      };
      const r = await testProvider(db, fakeEncryptor, spyTester, p.id, "llama-3.2");
      expect(r).toEqual({ ok: true });
      expect(seen).toEqual({
        type: "openai-chat-completions",
        baseUrl: "http://localhost:1234/v1",
        apiKey: "sk-abcdefghij",
        model: "llama-3.2",
      });
      expect(JSON.stringify(r)).not.toContain("sk-abcdefghij"); // 结果不得携带明文
    });
  });
});

describe("builtin provider immutability", () => {
  /** 直插一个内置 provider（仓储无创建内置的函数；内置只由播种产生）。 */
  function insertBuiltin(db: ReturnType<typeof freshDb>): string {
    const row = db
      .insert(providers)
      .values({
        type: "openai-responses",
        label: "OpenAI",
        baseUrl: null,
        models: ["gpt-4o"],
        isBuiltin: true,
      })
      .returning()
      .get();
    return row.id;
  }

  it("toDto exposes isBuiltin (false for user-created)", () => {
    const db = freshDb();
    const dto = upsertProvider(db, fakeEncryptor, { type: "anthropic", label: "Mine" });
    expect(dto.isBuiltin).toBe(false);
  });

  it("listProviders reports isBuiltin=true for builtin rows", () => {
    const db = freshDb();
    insertBuiltin(db);
    expect(listProviders(db, fakeEncryptor)[0]?.isBuiltin).toBe(true);
  });

  it("allows editing key + models on a builtin", () => {
    const db = freshDb();
    const id = insertBuiltin(db);
    const dto = upsertProvider(db, fakeEncryptor, {
      id,
      type: "openai-responses",
      apiKey: "sk-builtinkey1",
      models: ["gpt-4o", "gpt-4o-mini"],
    });
    expect(dto.models).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(revealProviderKey(db, fakeEncryptor, id)).toBe("sk-builtinkey1");
  });

  it("rejects changing type / label / baseUrl on a builtin", () => {
    const db = freshDb();
    const id = insertBuiltin(db);
    expect(() => upsertProvider(db, fakeEncryptor, { id, type: "anthropic" })).toThrow();
    expect(() =>
      upsertProvider(db, fakeEncryptor, { id, type: "openai-responses", label: "Renamed" }),
    ).toThrow();
    expect(() =>
      upsertProvider(db, fakeEncryptor, { id, type: "openai-responses", baseUrl: "https://x" }),
    ).toThrow();
  });

  it("refuses to remove a builtin provider", () => {
    const db = freshDb();
    const id = insertBuiltin(db);
    expect(() => removeProvider(db, id)).toThrow();
    expect(getProviderRow(db, id)).toBeDefined(); // 仍在
  });

  it("allows switching type within compatibleApis on a multi-API builtin; rejects outside", () => {
    const db = freshDb();
    const row = db
      .insert(providers)
      .values({
        type: "openai-responses",
        compatibleApis: ["openai-responses", "anthropic"],
        label: "Multi",
        models: ["m1"],
        isBuiltin: true,
      })
      .returning()
      .get();
    const ok = upsertProvider(db, fakeEncryptor, { id: row.id, type: "anthropic" });
    expect(ok.type).toBe("anthropic"); // 切到 compatibleApis 内 → 成功
    expect(() =>
      upsertProvider(db, fakeEncryptor, { id: row.id, type: "google-generate-content" }),
    ).toThrow(); // 切到 compatibleApis 外 → 抛
  });
});
