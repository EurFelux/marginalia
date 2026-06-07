import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initAppService } from "../app/app-service";
import { createLogger, writeRendererLog } from "./logger-service";
import * as barrel from "./index";

let dataDir: string;
let logsDir: string;

function inject(isDev: boolean): void {
  dataDir = mkdtempSync(path.join(tmpdir(), "logger-test-"));
  logsDir = path.join(dataDir, "logs");
  initAppService({ dataDir, isDev, openFolder: async () => {} });
}

function readLog(source: "main" | "renderer"): string {
  const file = readdirSync(logsDir).find((f) => f.startsWith(`${source}-`));
  if (!file) throw new Error(`no ${source} log file in ${logsDir}`);
  return readFileSync(path.join(logsDir, file), "utf8");
}

describe("logger-service (main)", () => {
  beforeEach(() => {
    inject(false);
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("writes a four-segment line to the main log file and echoes to console", () => {
    createLogger("send").error("stream failed");
    const content = readLog("main");
    expect(content).toMatch(
      /^\[\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z\] \[main\] \[error\] \[send\] stream failed\n$/,
    );
    expect(console.error).toHaveBeenCalledTimes(1); // 恒双写：每条落盘日志同步输出 console
  });

  it("expands Error message and stack with two-space indent", () => {
    const err = new Error("boom");
    createLogger("db").error("init failed", err);
    const content = readLog("main");
    expect(content).toContain("[main] [error] [db] init failed");
    expect(content).toMatch(/\n {2}Error: boom/);
    expect(content).toMatch(/\n {2}at /); // stack 行缩进两格
  });

  it("drops debug when isDev is false, records it when true", () => {
    createLogger("x").debug("hidden");
    let entries: string[];
    try {
      entries = readdirSync(logsDir);
    } catch {
      entries = []; // logsDir not created = nothing was logged
    }
    expect(entries.length === 0 || !readLog("main").includes("hidden")).toBe(true);

    inject(true); // last-wins 重注入 dev env（新 tmp 目录）
    createLogger("x").debug("visible");
    expect(readLog("main")).toContain("[main] [debug] [x] visible");
  });

  it("keeps ANSI escapes out of the file", () => {
    createLogger("y").warn("colored");
    expect(readLog("main")).not.toContain("\x1b[");
  });

  it("indents every continuation line of a multiline message (forged-line injection defense)", () => {
    // renderer 可经 log:write 在 message 里嵌换行——非首行必须强制缩进，伪造的“日志行”无法顶格成为合法条目
    writeRendererLog(
      "error",
      "evil",
      "real msg\n[2026-01-01T00:00:00.000Z] [main] [error] [fake] forged line",
    );
    const content = readLog("renderer");
    expect(content).toContain("\n  [2026-01-01T00:00:00.000Z] [main] [error] [fake] forged line");
    expect(content).not.toMatch(/\n\[2026-01-01/); // 顶格的伪造行不存在
  });

  it("collapses whitespace in module names to keep the four-segment header single-line", () => {
    writeRendererLog("warn", "a\nb", "msg");
    expect(readLog("renderer")).toContain("[renderer] [warn] [a b] msg");
  });

  it("truncates oversized bodies with a marker", () => {
    createLogger("big").warn("x".repeat(10_000));
    const content = readLog("main");
    expect(content).toContain("…[truncated]");
    expect(content.length).toBeLessThan(9_000);
  });

  it("writeRendererLog lands in the renderer file and does NOT echo to main console", () => {
    writeRendererLog("error", "boundary", "component crashed");
    const content = readLog("renderer");
    expect(content).toContain("[renderer] [error] [boundary] component crashed");
    expect(console.error).not.toHaveBeenCalled(); // 进程分流：renderer 日志不回显 main stdout
    expect(console.warn).not.toHaveBeenCalled();
    expect(console.log).not.toHaveBeenCalled();
  });

  it("falls back to console without throwing when the file write fails", () => {
    // 把 logsDir 占成同名文件，使 mkdir/append 失败
    inject(false);
    writeFileSync(logsDir, "not a dir");
    expect(() => createLogger("z").error("disk trouble")).not.toThrow();
    expect(console.error).toHaveBeenCalled(); // 至少 console 这条线还活着
  });

  it("never throws on exotic error values (symbol / function / circular)", () => {
    const log = createLogger("edge");
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => log.error("sym", Symbol("s"))).not.toThrow();
    expect(() => log.error("fn", () => {})).not.toThrow();
    expect(() => log.error("circ", circular)).not.toThrow();
    const content = readLog("main");
    expect(content).toContain("[main] [error] [edge] sym");
  });
});

describe("logger barrel", () => {
  it("exposes only createLogger (encapsulation does not leak)", () => {
    expect(Object.keys(barrel).sort()).toEqual(["createLogger"]);
  });
});
