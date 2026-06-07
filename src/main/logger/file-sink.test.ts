import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appendLogLine, cleanupExpiredLogs, logFileName } from "./file-sink";

function makeDir(): string {
  return mkdtempSync(path.join(tmpdir(), "file-sink-test-"));
}

describe("logFileName", () => {
  it("names files by source and date", () => {
    const d = new Date("2026-06-07T12:00:00Z");
    expect(logFileName("main", d)).toBe("main-2026-06-07.log");
    expect(logFileName("renderer", d)).toBe("renderer-2026-06-07.log");
  });
});

describe("appendLogLine", () => {
  it("writes the line into the dated per-source file (lazy-creating the dir)", () => {
    const dir = path.join(makeDir(), "logs"); // 不存在的子目录——验证 lazy mkdir
    appendLogLine(dir, "main", "hello line", new Date("2026-06-07T12:00:00Z"));
    const content = readFileSync(path.join(dir, "main-2026-06-07.log"), "utf8");
    expect(content).toBe("hello line\n");
  });

  it("appends to the same file and separates sources", () => {
    const dir = makeDir();
    const d = new Date("2026-06-07T12:00:00Z");
    appendLogLine(dir, "main", "m1", d);
    appendLogLine(dir, "renderer", "r1", d);
    appendLogLine(dir, "main", "m2", d);
    expect(readFileSync(path.join(dir, "main-2026-06-07.log"), "utf8")).toBe("m1\nm2\n");
    expect(readFileSync(path.join(dir, "renderer-2026-06-07.log"), "utf8")).toBe("r1\n");
  });

  it("rolls to a new file when the date changes", () => {
    const dir = makeDir();
    appendLogLine(dir, "main", "day1", new Date("2026-06-07T23:59:00Z"));
    appendLogLine(dir, "main", "day2", new Date("2026-06-08T00:01:00Z"));
    expect(existsSync(path.join(dir, "main-2026-06-07.log"))).toBe(true);
    expect(existsSync(path.join(dir, "main-2026-06-08.log"))).toBe(true);
  });
});

describe("cleanupExpiredLogs", () => {
  it("deletes log files older than 30 days and keeps recent + non-log files", () => {
    const dir = makeDir();
    const now = new Date("2026-06-07T12:00:00Z");
    writeFileSync(path.join(dir, "main-2026-05-01.log"), "old\n"); // 37 天前 → 删
    writeFileSync(path.join(dir, "renderer-2026-05-01.log"), "old\n"); // 同上 → 删
    writeFileSync(path.join(dir, "main-2026-05-20.log"), "recent\n"); // 18 天前 → 留
    writeFileSync(path.join(dir, "notes.txt"), "keep\n"); // 非日志命名 → 不误删
    cleanupExpiredLogs(dir, now);
    const left = readdirSync(dir).sort();
    expect(left).toEqual(["main-2026-05-20.log", "notes.txt"]);
  });

  it("is a no-op when the dir does not exist", () => {
    expect(() => cleanupExpiredLogs("/nonexistent/dir/xyz", new Date())).not.toThrow();
  });
});
