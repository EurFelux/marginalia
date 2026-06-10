import fs from "node:fs";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";

/**
 * 验证「删 assistants → 数据搬运进 preferences」迁移的搬运 SQL 语义（spec 2026-06-10 §2.3）。
 *
 * drizzle 不生成数据迁移，故搬运语句是手插在 migration.sql 文件头（DROP 之前）的有意例外。
 * vitest 无法分段跑迁移，这里直接从真实 migration.sql 抽出前缀的搬运语句（DDL 之前的部分，
 * 以 `PRAGMA foreign_keys=OFF` 为界），对手建的「旧结构」库执行，断言 preferences 结果——
 * SQL 字面量单一源仍是迁移文件本身，不在测试里复制。
 */
const MIGRATION_DIR = path.resolve(__dirname, "migrations/20260610121829_known_ken_ellis");

/** 抽出迁移文件里「数据搬运」前缀（DROP/重建 DDL 之前的语句），按 statement-breakpoint 切分。 */
function dataCarryStatements(): string[] {
  const sql = fs.readFileSync(path.join(MIGRATION_DIR, "migration.sql"), "utf8");
  // 搬运语句全部位于第一个 `PRAGMA foreign_keys=OFF` 之前（DDL 起点）。
  const ddlStart = sql.indexOf("PRAGMA foreign_keys=OFF");
  const prefix = ddlStart === -1 ? sql : sql.slice(0, ddlStart);
  return prefix
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/** 手建迁移运行前的「旧结构」最小子集：assistants（待删）+ preferences（搬运目标）。 */
function oldSchemaDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE assistants (
      id text PRIMARY KEY,
      name text NOT NULL,
      system_prompt text,
      provider_id text,
      model text,
      created_at integer NOT NULL
    );
    CREATE TABLE preferences (
      key text PRIMARY KEY,
      value text NOT NULL,
      updated_at integer NOT NULL
    );
  `);
  return db;
}

const DEFAULT_PROMPT =
  "You are a reading assistant embedded in an e-book reader. The user is reading a book and may select text to ask about it. Ground your answers in the provided selection, surrounding paragraphs, and chapter summary. When you need more of the original text, use the available reading tools. Answer concisely.";

function runCarry(db: ReturnType<typeof oldSchemaDb>) {
  for (const stmt of dataCarryStatements()) db.exec(stmt);
}

describe("assistants → preferences data-carry migration", () => {
  it("extracts exactly the two carry INSERTs from the migration file", () => {
    const stmts = dataCarryStatements();
    expect(stmts).toHaveLength(2);
    expect(stmts[0]).toContain("'chatModel'");
    expect(stmts[1]).toContain("'instructions'");
  });

  it("carries provider+model into chatModel as a JSON object", () => {
    const db = oldSchemaDb();
    db.prepare(
      "INSERT INTO assistants (id, name, system_prompt, provider_id, model, created_at) VALUES (?,?,?,?,?,?)",
    ).run("a1", "Default", DEFAULT_PROMPT, "prov-1", "gpt-4o-mini", 100);

    runCarry(db);

    const row = db.prepare("SELECT value FROM preferences WHERE key = 'chatModel'").get() as
      | { value: string }
      | undefined;
    expect(row).toBeDefined();
    expect(JSON.parse(row!.value)).toEqual({ providerId: "prov-1", model: "gpt-4o-mini" });
  });

  it("does NOT carry chatModel when provider/model are null", () => {
    const db = oldSchemaDb();
    db.prepare(
      "INSERT INTO assistants (id, name, system_prompt, provider_id, model, created_at) VALUES (?,?,?,?,?,?)",
    ).run("a1", "Default", DEFAULT_PROMPT, null, null, 100);

    runCarry(db);

    expect(
      db.prepare("SELECT value FROM preferences WHERE key = 'chatModel'").get(),
    ).toBeUndefined();
  });

  it("carries a customized system_prompt into instructions as a JSON string", () => {
    const db = oldSchemaDb();
    const custom = "Answer like a pirate.";
    db.prepare(
      "INSERT INTO assistants (id, name, system_prompt, provider_id, model, created_at) VALUES (?,?,?,?,?,?)",
    ).run("a1", "Default", custom, null, null, 100);

    runCarry(db);

    const row = db.prepare("SELECT value FROM preferences WHERE key = 'instructions'").get() as
      | { value: string }
      | undefined;
    expect(row).toBeDefined();
    // json_quote 产出 JSON 字符串值（含外层引号）；mode:"json" 列读出即纯字符串。
    expect(JSON.parse(row!.value)).toBe(custom);
  });

  it("does NOT carry instructions when system_prompt is still the old default text", () => {
    const db = oldSchemaDb();
    db.prepare(
      "INSERT INTO assistants (id, name, system_prompt, provider_id, model, created_at) VALUES (?,?,?,?,?,?)",
    ).run("a1", "Default", DEFAULT_PROMPT, null, null, 100);

    runCarry(db);

    expect(
      db.prepare("SELECT value FROM preferences WHERE key = 'instructions'").get(),
    ).toBeUndefined();
  });

  it("picks the earliest-created assistant when several exist", () => {
    const db = oldSchemaDb();
    const insert = db.prepare(
      "INSERT INTO assistants (id, name, system_prompt, provider_id, model, created_at) VALUES (?,?,?,?,?,?)",
    );
    insert.run("a-late", "Late", DEFAULT_PROMPT, "prov-late", "model-late", 200);
    insert.run("a-early", "Early", DEFAULT_PROMPT, "prov-early", "model-early", 100);

    runCarry(db);

    const row = db.prepare("SELECT value FROM preferences WHERE key = 'chatModel'").get() as {
      value: string;
    };
    expect(JSON.parse(row.value)).toEqual({ providerId: "prov-early", model: "model-early" });
  });

  it("does not clobber an existing chatModel preference (ON CONFLICT DO NOTHING)", () => {
    const db = oldSchemaDb();
    db.prepare("INSERT INTO preferences (key, value, updated_at) VALUES (?,?,?)").run(
      "chatModel",
      JSON.stringify({ providerId: "preexisting", model: "kept" }),
      50,
    );
    db.prepare(
      "INSERT INTO assistants (id, name, system_prompt, provider_id, model, created_at) VALUES (?,?,?,?,?,?)",
    ).run("a1", "Default", DEFAULT_PROMPT, "prov-1", "gpt-4o-mini", 100);

    runCarry(db);

    const row = db.prepare("SELECT value FROM preferences WHERE key = 'chatModel'").get() as {
      value: string;
    };
    expect(JSON.parse(row.value)).toEqual({ providerId: "preexisting", model: "kept" });
  });
});
