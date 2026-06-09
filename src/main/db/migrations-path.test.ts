import path from "node:path";
import { describe, expect, it } from "vitest";
import { latestMigrationDir, listMigrationDirs } from "@main/db/migrations-path";

const MIG = path.resolve(process.cwd(), "src/main/db/migrations");

describe("migrations-path", () => {
  it("lists migration subdirectories sorted by name", () => {
    const dirs = listMigrationDirs(MIG);
    expect(dirs.length).toBeGreaterThan(0);
    expect(dirs).toEqual([...dirs].sort());
    // every entry looks like <timestamp>_<name>
    expect(dirs.every((d) => /^\d+_/.test(d))).toBe(true);
  });

  it("latest = lexicographically last dir", () => {
    const dirs = listMigrationDirs(MIG);
    expect(latestMigrationDir(MIG)).toBe(dirs[dirs.length - 1]);
  });

  it("empty/missing folder yields no dirs and empty head", () => {
    const none = path.resolve(process.cwd(), "src/main/db/__nope__");
    expect(listMigrationDirs(none)).toEqual([]);
    expect(latestMigrationDir(none)).toBe("");
  });
});
