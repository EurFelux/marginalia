import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { getAppInfo, ping } from "@main/app-service";

const MIGRATIONS = path.resolve(__dirname, "db/migrations");

describe("app-service", () => {
  it("ping echoes the message", () => {
    expect(ping({ msg: "hello" })).toEqual({ echo: "hello" });
  });

  it("getAppInfo returns version and live book count", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    const info = getAppInfo(db, "9.9.9");
    expect(info).toEqual({ version: "9.9.9", bookCount: 0 });
  });
});
