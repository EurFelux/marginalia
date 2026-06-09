import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, type DB } from "@main/db/client";
import { books } from "@main/db/schema";
import { buildManifest } from "@main/backup/manifest";

const MIG = path.resolve(process.cwd(), "src/main/db/migrations");
let db: DB;
beforeEach(() => {
  db = createDb(":memory:");
  runMigrations(db, MIG);
});

describe("buildManifest", () => {
  it("counts books and stamps the passed-in fields", () => {
    db.insert(books)
      .values([{ id: "b1" }, { id: "b2" }])
      .run();
    const m = buildManifest(db, { appVersion: "1.2.3", schemaHead: "0009_x", dbSha256: "abc123" });
    expect(m.bookCount).toBe(2);
    expect(m.appVersion).toBe("1.2.3");
    expect(m.schemaHead).toBe("0009_x");
    expect(m.dbSha256).toBe("abc123");
    expect(m.formatVersion).toBe(1);
    expect(m.includesApiKeys).toBe(true);
    expect(typeof m.createdAt).toBe("number");
  });

  it("bookCount is 0 on an empty library", () => {
    expect(buildManifest(db, { appVersion: "1", schemaHead: "h", dbSha256: "x" }).bookCount).toBe(
      0,
    );
  });
});
