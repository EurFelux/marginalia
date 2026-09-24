import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { providers } from "@main/db/schema";
import { DEFAULT_PROVIDERS, ensureBuiltinProviders } from "@main/providers/default-providers";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("ensureBuiltinProviders", () => {
  it("inserts all builtin defaults into an empty table", () => {
    const db = freshDb();
    ensureBuiltinProviders(db);
    const rows = db.select().from(providers).all();
    expect(rows).toHaveLength(DEFAULT_PROVIDERS.length);
    const byLabel = Object.fromEntries(rows.map((r) => [r.label, r]));
    expect(byLabel.OpenAI.type).toBe("openai-responses");
    // 对照真相源（DEFAULT_PROVIDERS），避免日后更新默认型号时这条断言过时。
    expect(byLabel.OpenAI.models).toEqual(
      DEFAULT_PROVIDERS.find((p) => p.label === "OpenAI")?.models,
    );
    expect(byLabel.OpenAI.apiKey).toBeNull();
    expect(byLabel.OpenAI.baseUrl).toBeNull();
    expect(byLabel.OpenAI.isBuiltin).toBe(true);
    expect(byLabel.Anthropic.type).toBe("anthropic");
    expect(byLabel.Gemini.label).toBe("Gemini");
    // DeepSeek：三兼容 API，baseUrl 不入库（按 type 派生）。
    expect(byLabel.DeepSeek.type).toBe("openai-chat-completions");
    expect(byLabel.DeepSeek.compatibleApis).toEqual([
      "openai-chat-completions",
      "openai-responses",
      "anthropic",
    ]);
    expect(byLabel.DeepSeek.baseUrl).toBeNull();
    expect(byLabel.DeepSeek.isBuiltin).toBe(true);
  });

  it("is idempotent — second run inserts nothing", () => {
    const db = freshDb();
    ensureBuiltinProviders(db);
    ensureBuiltinProviders(db);
    expect(db.select().from(providers).all()).toHaveLength(DEFAULT_PROVIDERS.length);
  });

  it("only fills the missing builtin, preserving an existing builtin's edits", () => {
    const db = freshDb();
    // 预置一个内置 OpenAI（用户已填 key/改 models 的等价物）；只缺 Anthropic/Gemini。
    db.insert(providers)
      .values({
        type: "openai-responses",
        label: "OpenAI",
        models: ["custom-model"],
        isBuiltin: true,
      })
      .run();
    ensureBuiltinProviders(db);
    const rows = db.select().from(providers).all();
    expect(rows).toHaveLength(DEFAULT_PROVIDERS.length); // 补了 2 个，没重复 OpenAI
    const openai = rows.find((r) => r.label === "OpenAI");
    expect(openai?.models).toEqual(["custom-model"]); // 既有内置不被覆盖
  });

  it("upgrades an existing builtin's compatibleApis with newly supported APIs, preserving type/key/models", () => {
    const db = freshDb();
    // 预置 Responses API 支持之前的旧内置 DeepSeek 行（两项 compatibleApis，用户已选 anthropic、已填 key）。
    db.insert(providers)
      .values({
        type: "anthropic",
        compatibleApis: ["openai-chat-completions", "anthropic"],
        label: "DeepSeek",
        apiKey: "sk-user-key",
        models: ["deepseek-v4-pro"],
        isBuiltin: true,
      })
      .run();
    ensureBuiltinProviders(db);
    const ds = db
      .select()
      .from(providers)
      .all()
      .find((r) => r.isBuiltin && r.label === "DeepSeek");
    expect(ds?.compatibleApis).toEqual([
      "openai-chat-completions",
      "openai-responses",
      "anthropic",
    ]);
    expect(ds?.type).toBe("anthropic"); // 用户已选 type 不动
    expect(ds?.apiKey).toBe("sk-user-key");
    expect(ds?.models).toEqual(["deepseek-v4-pro"]);
  });

  it("a user's non-builtin provider with the same label does NOT block the builtin", () => {
    const db = freshDb();
    db.insert(providers).values({ type: "anthropic", label: "OpenAI", isBuiltin: false }).run();
    ensureBuiltinProviders(db);
    const builtins = db
      .select()
      .from(providers)
      .all()
      .filter((r) => r.isBuiltin);
    expect(builtins).toHaveLength(DEFAULT_PROVIDERS.length); // 3 个内置都补齐
    // 仍存在那个同名非内置
    expect(
      db
        .select()
        .from(providers)
        .all()
        .some((r) => !r.isBuiltin && r.label === "OpenAI"),
    ).toBe(true);
  });
});
