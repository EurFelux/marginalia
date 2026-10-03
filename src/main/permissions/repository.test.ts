import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import {
  addPermissionRule,
  deletePermissionRule,
  listPermissionRules,
} from "@main/permissions/repository";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("permission rules repository", () => {
  it("adds, lists in creation order, and deletes", () => {
    const db = freshDb();
    const a = addPermissionRule(db, { tool: "bash", decision: "allow", pattern: "git status" });
    const b = addPermissionRule(db, { tool: "bash", decision: "deny", pattern: "rm" });
    expect(listPermissionRules(db).map((r) => r.id)).toEqual([a.id, b.id]);
    expect(listPermissionRules(db, "bash")).toHaveLength(2);
    deletePermissionRule(db, a.id);
    expect(listPermissionRules(db).map((r) => r.pattern)).toEqual(["rm"]);
  });

  it("normalizes the pattern and dedupes equivalent spellings", () => {
    const db = freshDb();
    const a = addPermissionRule(db, {
      tool: "bash",
      decision: "allow",
      pattern: "  git   status ",
    });
    const b = addPermissionRule(db, {
      tool: "bash",
      decision: "allow",
      pattern: "'git' \"status\"",
    });
    expect(a.pattern).toBe("git status");
    expect(b.id).toBe(a.id);
    expect(listPermissionRules(db)).toHaveLength(1);
  });

  it("keeps an allow and a deny rule with the same pattern apart", () => {
    const db = freshDb();
    addPermissionRule(db, { tool: "bash", decision: "allow", pattern: "rm" });
    addPermissionRule(db, { tool: "bash", decision: "deny", pattern: "rm" });
    expect(listPermissionRules(db)).toHaveLength(2);
  });

  it("rejects patterns that are not plain token sequences", () => {
    const db = freshDb();
    for (const pattern of ["ls; rm", "echo $HOME", "a | b"]) {
      expect(() => addPermissionRule(db, { tool: "bash", decision: "allow", pattern })).toThrow(
        /invalid rule pattern/,
      );
    }
    expect(listPermissionRules(db)).toHaveLength(0);
  });

  it("enforces enum columns at the DB layer", () => {
    const db = freshDb();
    expect(() =>
      db.$client
        .prepare(
          "insert into permission_rules (id, tool, decision, pattern, created_at) values ('x', 'web', 'allow', 'ls', 0)",
        )
        .run(),
    ).toThrow(/CHECK/);
  });
});
