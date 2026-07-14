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
    const m = buildManifest(db, {
      kind: "compact",
      appVersion: "1.2.3",
      schemaHead: "0009_x",
      dbSha256: "abc123",
      createdAt: 1_700_000_000_000,
    });
    expect(m).toMatchObject({
      formatVersion: 2,
      kind: "compact",
      appVersion: "1.2.3",
      schemaHead: "0009_x",
      dbSha256: "abc123",
      createdAt: 1_700_000_000_000,
      bookCount: 2,
      includesApiKeys: true,
    });
  });

  it("bookCount is 0 on an empty library", () => {
    expect(
      buildManifest(db, {
        kind: "full",
        appVersion: "1",
        schemaHead: "h",
        dbSha256: "x",
        createdAt: 1,
      }).bookCount,
    ).toBe(0);
  });
});
