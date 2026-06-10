import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { eq, sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { books, chapters, conversations, providers } from "@main/db/schema";

const MIGRATIONS = path.resolve(__dirname, "migrations");

/** 在 folder 下写一个 drizzle 风格迁移子目录（仅需 migration.sql；目录名前 14 位须为时间戳）。 */
function writeMigration(folder: string, name: string, statements: string[]): void {
  const sub = path.join(folder, name);
  fs.mkdirSync(sub, { recursive: true });
  fs.writeFileSync(
    path.join(sub, "migration.sql"),
    statements.join("\n--> statement-breakpoint\n"),
  );
}

describe("db client", () => {
  it("runs migrations and round-trips a provider with a uuidv7 id", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);

    db.insert(providers).values({ type: "openai-responses", label: "test" }).run();

    const rows = db.select().from(providers).where(eq(providers.type, "openai-responses")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("test");
    expect(rows[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it("enforces foreign key constraints", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    expect(() => db.insert(conversations).values({ bookId: "nonexistent-id" }).run()).toThrow(
      /FOREIGN KEY/i,
    );
  });

  it("rejects an invalid enum value via CHECK constraint", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    expect(() =>
      // @ts-expect-error intentionally violating the type-level enum to test the SQL CHECK
      db.insert(providers).values({ type: "bogus" }).run(),
    ).toThrow();
  });

  it("rejects an invalid book format via CHECK constraint", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    expect(() =>
      // @ts-expect-error intentionally violating the type-level enum to test the SQL CHECK
      db.insert(books).values({ id: "b-fmt", format: "word" }).run(),
    ).toThrow();
  });

  it("rejects a chapter referencing a non-existent book (FK)", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    expect(() =>
      db.insert(chapters).values({ bookId: "no-such-book", href: "x.xhtml" }).run(),
    ).toThrow(/FOREIGN KEY/i);
  });

  it("enforces UNIQUE(book_id, href, anchor) on chapters", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    db.insert(books).values({ id: "b1" }).run();
    // 同一 (book_id, href, anchor) 有非 null anchor 时不能重复
    db.insert(chapters).values({ bookId: "b1", href: "big.xhtml", anchor: "a1" }).run();
    db.insert(chapters).values({ bookId: "b1", href: "big.xhtml", anchor: "a2" }).run();
    expect(() =>
      db.insert(chapters).values({ bookId: "b1", href: "big.xhtml", anchor: "a1" }).run(),
    ).toThrow();
    // SQLite UNIQUE 约束：NULL != NULL，故 (book_id, href, null) 重复不触发约束（标准行为）；
    // 导入层通过 chapterSeedsFromToc 去重保首个，应用层保证不写重复 null 行。
    db.insert(chapters).values({ bookId: "b1", href: "ch1.xhtml" }).run();
    expect(() =>
      db.insert(chapters).values({ bookId: "b1", href: "ch1.xhtml" }).run(),
    ).not.toThrow(); // anchor IS NULL: SQLite UNIQUE 不拦
  });

  // 回归：drizzle 把迁移包在 BEGIN…COMMIT 里跑，迁移 SQL 自带的 `PRAGMA foreign_keys=OFF`
  // 在事务内是 no-op；表重建型迁移（建新表→拷贝→DROP 旧表→改名）的 DROP 触发隐式 DELETE，
  // 若 FK 仍开且有子表行引用旧表则报 SQLITE_CONSTRAINT_FOREIGNKEY。runMigrations 须在事务外关 FK。
  it("applies table-recreate migrations even when child rows reference the recreated table", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "marginalia-mig-"));
    try {
      // m1：父表 + 子表（子表外键指向父表）
      writeMigration(dir, "20200101000000_init", [
        "CREATE TABLE `parent` (`id` text PRIMARY KEY, `note` text);",
        "CREATE TABLE `child` (`id` text PRIMARY KEY, `parent_id` text NOT NULL, CONSTRAINT `fk_child_parent` FOREIGN KEY (`parent_id`) REFERENCES `parent`(`id`));",
      ]);
      const db = createDb(":memory:");
      runMigrations(db, dir); // 仅应用 m1

      // 播种子行引用父行——这正是用户库里 messages→conversations 的形态
      db.run(sql`INSERT INTO parent (id) VALUES ('p1')`);
      db.run(sql`INSERT INTO child (id, parent_id) VALUES ('c1', 'p1')`);

      // m2：重建父表（drizzle 列变更迁移的标准形态）
      writeMigration(dir, "20200101000001_recreate_parent", [
        "PRAGMA foreign_keys=OFF;",
        "CREATE TABLE `__new_parent` (`id` text PRIMARY KEY, `note` text, `added` integer);",
        "INSERT INTO `__new_parent`(`id`, `note`) SELECT `id`, `note` FROM `parent`;",
        "DROP TABLE `parent`;",
        "ALTER TABLE `__new_parent` RENAME TO `parent`;",
        "PRAGMA foreign_keys=ON;",
      ]);

      expect(() => runMigrations(db, dir)).not.toThrow();

      // 数据保全 + 运行期 FK 重新开启
      expect(db.all<{ id: string }>(sql`SELECT id FROM parent`)).toEqual([{ id: "p1" }]);
      expect(db.all<{ parent_id: string }>(sql`SELECT parent_id FROM child`)).toEqual([
        { parent_id: "p1" },
      ]);
      expect(db.get<{ foreign_keys: number }>(sql`PRAGMA foreign_keys`)?.foreign_keys).toBe(1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
