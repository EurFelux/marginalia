# LoggerService（持久化日志系统）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 实现 #32 持久化日志：主/渲染进程分流的文件日志（按日期轮转、30 天保留）+ 恒双写 console + 渲染层错误 funnel + 设置页「打开日志文件夹」入口。

**Architecture:** 两侧同形组织（`logger-service.ts` 类+单例不导出、barrel 仅 `createLogger`）。main 侧 service 双写 stdout（ANSI 着色）+ `main-YYYY-MM-DD.log`；renderer 侧双写 DevTools console + 经 `log:write` IPC 落 `renderer-YYYY-MM-DD.log`（main 不回显 stdout）。路径经 `appService.getPath("logsDir")`，级别门槛 debug 仅 `appService.isDev`。Spec：`docs/superpowers/specs/2026-06-07-persistent-logging-design.md`。

**Tech Stack:** TypeScript 6（strict）、vitest 4、Zod 4（IPC schema）、React 19（ErrorBoundary）、i18next。

**File structure:**

```
src/main/logger/
  file-sink.ts                 # Task 1: 按日期+进程写文件、30 天清理（纯函数，注入 logsDir）
  file-sink.test.ts            # Task 1
  logger-service.ts            # Task 2: LoggerService 类+单例（不导出）+ createLogger + writeRendererLog（深导出）
  logger-service.test.ts       # Task 2/3
  index.ts                     # Task 2: barrel，仅 createLogger
src/shared/ipc.ts              # Task 3: logWrite + appOpenLogsDir 通道
src/main/ipc/log-handlers.ts   # Task 3: 两通道 handler
src/main.ts                    # Task 3: registerLogHandlers；Task 5: console 替换 + process 钩子
src/preload-api.ts             # Task 3: api.log.write / api.app.openLogsDir
src/renderer/logger/
  logger-service.ts            # Task 4: 同形组织，双写 DevTools console + IPC
  index.ts                     # Task 4: barrel，仅 createLogger
src/renderer/ErrorBoundary.tsx # Task 4
src/renderer.tsx               # Task 4: 三件套接线
src/main/{ai,chat,library,ipc,secrets}/*.ts  # Task 5: 17 处 console 替换
src/renderer/store/settings-store.ts          # Task 6: SettingsCategory + "advanced"
src/renderer/settings/SettingsShell.tsx       # Task 6
src/renderer/settings/AdvancedSettings.tsx    # Task 6
src/shared/i18n/locales/{en,zh-CN}.ts         # Task 6
```

注意：pre-commit hook（prek）可能以 "files were modified by this hook" 中止提交——重新 `git add` 被改文件后再执行同一条 commit 命令。**绝对不要切换分支**（当前 `feat/persistent-logging`），commit 前 `git branch --show-current` 确认。

---

### Task 1: file-sink（TDD）

纯函数模块：写入指定日志目录、按日期+进程命名、30 天清理。不依赖 appService（logsDir 由调用方注入）——独立可测。

**Files:**

- Create: `src/main/logger/file-sink.ts`
- Test: `src/main/logger/file-sink.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/main/logger/file-sink.test.ts`：

```typescript
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/logger/file-sink.test.ts`
Expected: FAIL——`Cannot find module './file-sink'`。

- [ ] **Step 3: 实现**

创建 `src/main/logger/file-sink.ts`：

```typescript
/**
 * file-sink：日志文件写入（按日期 + 进程来源命名）与 30 天过期清理。
 * 纯函数——logsDir 由调用方（LoggerService）注入，不依赖 appService，独立可测。
 */
import { appendFileSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import path from "node:path";

export type LogSource = "main" | "renderer";

const RETENTION_DAYS = 30;
const LOG_FILE_RE = /^(?:main|renderer)-(\d{4}-\d{2}-\d{2})\.log$/;

function dateStamp(d: Date): string {
  return d.toISOString().slice(0, 10); // YYYY-MM-DD（UTC，与行内时间戳同基准）
}

export function logFileName(source: LogSource, date: Date): string {
  return `${source}-${dateStamp(date)}.log`;
}

/** 追加一行（自动补 \n）。目录 lazy 创建；写入失败向上抛——由 LoggerService 统一降级 console */
export function appendLogLine(logsDir: string, source: LogSource, line: string, date: Date): void {
  mkdirSync(logsDir, { recursive: true });
  appendFileSync(path.join(logsDir, logFileName(source, date)), `${line}\n`);
}

/** 删除文件名日期早于 30 天的日志；非日志命名的文件不动。目录不存在则 no-op */
export function cleanupExpiredLogs(logsDir: string, now: Date): void {
  let entries: string[];
  try {
    entries = readdirSync(logsDir);
  } catch {
    return; // 目录不存在等——清理是 best-effort
  }
  const cutoff = new Date(now.getTime() - RETENTION_DAYS * 24 * 60 * 60 * 1000);
  const cutoffStamp = dateStamp(cutoff);
  for (const name of entries) {
    const m = LOG_FILE_RE.exec(name);
    if (m && m[1] < cutoffStamp) {
      try {
        rmSync(path.join(logsDir, name));
      } catch {
        // best-effort：单个文件删除失败不阻塞其余清理
      }
    }
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/logger/file-sink.test.ts`
Expected: 6 个测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/logger/file-sink.ts src/main/logger/file-sink.test.ts
git commit -m "feat(main): add logger file sink with daily per-process files"
```

---

### Task 2: main 侧 LoggerService + barrel（TDD）

**Files:**

- Create: `src/main/logger/logger-service.ts`
- Create: `src/main/logger/index.ts`
- Test: `src/main/logger/logger-service.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/main/logger/logger-service.test.ts`：

```typescript
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
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
    expect(readdirSync(logsDir).length === 0 || !readLog("main").includes("hidden")).toBe(true);

    inject(true); // last-wins 重注入 dev env（新 tmp 目录）
    createLogger("x").debug("visible");
    expect(readLog("main")).toContain("[main] [debug] [x] visible");
  });

  it("keeps ANSI escapes out of the file", () => {
    createLogger("y").warn("colored");
    expect(readLog("main")).not.toContain("\x1b[");
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
    const fsMod = require("node:fs") as typeof import("node:fs");
    fsMod.writeFileSync(logsDir, "not a dir");
    expect(() => createLogger("z").error("disk trouble")).not.toThrow();
    expect(console.error).toHaveBeenCalled(); // 至少 console 这条线还活着
  });
});

describe("logger barrel", () => {
  it("exposes only createLogger (encapsulation does not leak)", () => {
    expect(Object.keys(barrel).sort()).toEqual(["createLogger"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/logger/logger-service.test.ts`
Expected: FAIL——`Cannot find module './logger-service'`。

- [ ] **Step 3: 实现**

创建 `src/main/logger/logger-service.ts`：

```typescript
/**
 * LoggerService（主进程）：级别过滤、四段式格式化、console 着色、文件落盘的统一中枢。
 * 薄实例（createLogger 产出）只持有 module 与级别方法——所有逻辑收敛在模块内单例。
 * 进程分流：main 日志 → stdout + main-*.log；renderer 日志（经 log:write IPC）→ renderer-*.log，不回显 stdout。
 * Spec: docs/superpowers/specs/2026-06-07-persistent-logging-design.md
 */
import path from "node:path";
import { appService } from "../app";
import { appendLogLine, cleanupExpiredLogs, type LogSource } from "./file-sink";

export type LogLevel = "error" | "warn" | "info" | "debug";

/** 薄 logger：只持有 module 名；可选第二参 Error 会展开 message+stack */
export interface Logger {
  error(message: string, err?: unknown): void;
  warn(message: string, err?: unknown): void;
  info(message: string, err?: unknown): void;
  debug(message: string, err?: unknown): void;
}

const ANSI: Record<LogLevel, string> = {
  error: "\x1b[31m", // 红
  warn: "\x1b[33m", // 黄
  info: "\x1b[36m", // 青
  debug: "\x1b[90m", // 灰暗
};
const ANSI_RESET = "\x1b[0m";

const CONSOLE_FN: Record<LogLevel, (msg: string) => void> = {
  error: (m) => console.error(m),
  warn: (m) => console.warn(m),
  info: (m) => console.log(m),
  debug: (m) => console.log(m),
};

/** Error/unknown 展开为缩进两格的附加行；非 Error 值 String() 兜底 */
function formatErr(err: unknown): string {
  if (err === undefined) return "";
  const text = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  return `\n${text
    .split("\n")
    .map((l) => `  ${l.trimStart()}`)
    .join("\n")}`;
}

/** 类不导出：公共面仅 createLogger（barrel）与 writeRendererLog（log-handlers 深导入） */
class LoggerService {
  #cleanedStamp: string | null = null; // 当日已清理标记——日期翻转时再清一轮

  log(source: LogSource, level: LogLevel, module: string, message: string, err?: unknown): void {
    // 级别门槛：debug 仅 dev 记录（门槛判定统一收敛主进程侧）
    if (level === "debug" && !appService.isDev) return;

    const now = new Date();
    const line = `[${now.toISOString()}] [${source}] [${level}] [${module}] ${message}${formatErr(err)}`;

    // 恒双写之 console 侧：仅 main 来源回显 stdout——renderer 日志已在 DevTools 输出过，不混流
    if (source === "main") {
      const colored = process.stdout.isTTY ? `${ANSI[level]}${line}${ANSI_RESET}` : line;
      CONSOLE_FN[level](colored);
    }

    // 文件侧：写入失败静默降级（日志系统绝不搞崩业务）；fail-fast 的 appService 访问不在 try 里——
    // 未注入是初始化顺序 bug，应当抛
    const logsDir = appService.getPath("logsDir");
    try {
      const stamp = now.toISOString().slice(0, 10);
      if (this.#cleanedStamp !== stamp) {
        this.#cleanedStamp = stamp;
        cleanupExpiredLogs(logsDir, now);
      }
      appendLogLine(logsDir, source, line, now);
    } catch {
      if (source !== "main") CONSOLE_FN[level](line); // renderer 日志文件写失败时至少留 console 痕迹
      // main 日志已 console 输出过，文件失败静默
    }
  }
}

const service = new LoggerService();

/** 业务模块唯一入口（经 barrel）：每模块一个薄实例 */
export function createLogger(module: string): Logger {
  return {
    error: (m, e) => service.log("main", "error", module, m, e),
    warn: (m, e) => service.log("main", "warn", module, m, e),
    info: (m, e) => service.log("main", "info", module, m, e),
    debug: (m, e) => service.log("main", "debug", module, m, e),
  };
}

/** log:write IPC 专用入口（仅 log-handlers.ts 深导入，不进 barrel）：
 * 来源强制 [renderer]、落 renderer-*.log、不回显 main stdout */
export function writeRendererLog(level: LogLevel, module: string, message: string): void {
  service.log("renderer", level, module, message);
}
```

创建 `src/main/logger/index.ts`：

```typescript
/** barrel：仅 re-export createLogger——业务代码唯一入口。
 * writeRendererLog（IPC 胶水专用）有意不进 barrel（log-handlers.ts 深导入 logger/logger-service）。 */
export { createLogger } from "./logger-service";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/logger/logger-service.test.ts`
Expected: 7 个测试全 PASS。
注意：若 `falls back` 用例因 `require` 在 ESM 测试里报错，改用顶部 `import { writeFileSync } from "node:fs"` 后直接调用。

- [ ] **Step 5: Commit**

```bash
git add src/main/logger/
git commit -m "feat(main): add LoggerService with per-process sinks and console echo"
```

---

### Task 3: IPC 通道 + handler + preload（TDD 于 service 层）

**Files:**

- Modify: `src/shared/ipc.ts`（input schema 区 + `C` 对象末尾）
- Create: `src/main/ipc/log-handlers.ts`
- Modify: `src/main.ts`（import + register）
- Modify: `src/preload-api.ts`

- [ ] **Step 1: shared/ipc.ts 加 schema 与通道**

在 input schema 定义区（`pingInput` 附近，约 L46）追加：

```typescript
export const logWriteInput = z.object({
  level: z.enum(["error", "warn", "info", "debug"]),
  module: z.string().min(1),
  message: z.string(),
});
export type LogWriteInput = z.infer<typeof logWriteInput>;
```

在 `C` 对象末尾（`preferencesSet` 之后，约 L220）追加：

```typescript
  // logging
  logWrite: def("log:write", "invoke", logWriteInput, out<void>()),
  appOpenLogsDir: def("app:open-logs-dir", "invoke", z.void(), out<void>()),
```

- [ ] **Step 2: 创建 log-handlers.ts**

创建 `src/main/ipc/log-handlers.ts`：

```typescript
import { C } from "@shared/ipc";
import { appService } from "@main/app";
import { writeRendererLog } from "@main/logger/logger-service"; // 深导入：IPC 胶水专用入口
import { bind, register, type Binding } from "@main/ipc/registry";

export const logBindings: Binding[] = [
  bind(C.logWrite, (input) => writeRendererLog(input.level, input.module, input.message)),
  bind(C.appOpenLogsDir, () => appService.openFolder(appService.getPath("logsDir"))),
];

export function registerLogHandlers(): void {
  register(logBindings);
}
```

- [ ] **Step 3: main.ts 注册**

import 区追加：

```typescript
import { registerLogHandlers } from "@main/ipc/log-handlers";
```

`app.on("ready")` 内的 register 链（`registerAiHandlers();` 之后、`createWindow();` 之前）追加：

```typescript
registerLogHandlers();
```

- [ ] **Step 4: preload-api.ts 暴露**

`app` 命名空间（现有 `getInfo`/`locale`）追加成员，并新增顶层 `log` 命名空间：

```typescript
  app: {
    getInfo: inv(C.appGetInfo),
    locale: d.appLocale,
    openLogsDir: inv(C.appOpenLogsDir),
  },
  log: {
    write: inv(C.logWrite),
  },
```

- [ ] **Step 5: 验证 + Commit**

Run: `pnpm typecheck && pnpm test`
Expected: 全绿（Task 2 的 `writeRendererLog` 测试已覆盖 handler 背后的 service 行为；handler 本身是 bind 胶水，由 registry 的 validateInput 既有机制保障）。

```bash
git add src/shared/ipc.ts src/main/ipc/log-handlers.ts src/main.ts src/preload-api.ts
git commit -m "feat(ipc): add log:write and app:open-logs-dir channels"
```

---

### Task 4: renderer 侧 logger + 错误三件套

renderer 代码无 vitest 惯例（node 环境无 window），本任务靠 typecheck + Task 7 冒烟验证。

**Files:**

- Create: `src/renderer/logger/logger-service.ts`
- Create: `src/renderer/logger/index.ts`
- Create: `src/renderer/ErrorBoundary.tsx`
- Modify: `src/renderer.tsx`

- [ ] **Step 1: 创建 renderer logger-service**

创建 `src/renderer/logger/logger-service.ts`：

```typescript
/**
 * LoggerService（渲染层）：与主进程同形组织——类+单例不导出，barrel 仅 createLogger。
 * 双写：DevTools console（本进程可观测面）+ 经 log:write IPC 由主进程落 renderer-*.log。
 * 级别门槛（debug 仅 dev）统一在主进程侧判定——本层全量转发。
 */
import type { LogWriteInput } from "@shared/ipc";

type LogLevel = LogWriteInput["level"];

export interface Logger {
  error(message: string, err?: unknown): void;
  warn(message: string, err?: unknown): void;
  info(message: string, err?: unknown): void;
  debug(message: string, err?: unknown): void;
}

const CONSOLE_FN: Record<LogLevel, (...args: unknown[]) => void> = {
  error: console.error,
  warn: console.warn,
  info: console.log,
  debug: console.debug,
};

/** Error 展开为字符串供 IPC 传输（结构化对象过不了 contextBridge 的纯数据要求） */
function withErr(message: string, err?: unknown): string {
  if (err === undefined) return message;
  const text = err instanceof Error ? (err.stack ?? `${err.name}: ${err.message}`) : String(err);
  return `${message}\n${text}`;
}

class LoggerService {
  log(level: LogLevel, module: string, message: string, err?: unknown): void {
    // DevTools console：保留原始 err 对象（可展开 inspect），格式与文件侧四段式对齐
    CONSOLE_FN[level](
      `[renderer] [${level}] [${module}] ${message}`,
      ...(err === undefined ? [] : [err]),
    );
    // IPC 落盘：fire-and-forget，失败静默——日志绝不搞崩 UI
    void window.api.log.write({ level, module, message: withErr(message, err) }).catch(() => {});
  }
}

const service = new LoggerService();

export function createLogger(module: string): Logger {
  return {
    error: (m, e) => service.log("error", module, m, e),
    warn: (m, e) => service.log("warn", module, m, e),
    info: (m, e) => service.log("info", module, m, e),
    debug: (m, e) => service.log("debug", module, m, e),
  };
}
```

创建 `src/renderer/logger/index.ts`：

```typescript
/** barrel：仅 re-export createLogger——渲染层业务代码唯一入口（与主进程 logger 同形）。 */
export { createLogger } from "./logger-service";
```

- [ ] **Step 2: 创建 ErrorBoundary**

创建 `src/renderer/ErrorBoundary.tsx`：

```typescript
import { Component, type ReactNode } from "react";
import { createLogger } from "@renderer/logger";

const log = createLogger("boundary");

interface Props {
  children: ReactNode;
}
interface State {
  hasError: boolean;
}

/** 组件树崩溃兜底：上报日志 + 极简 fallback（刷新重试）。class 组件——React 仍无函数式 boundary */
export class ErrorBoundary extends Component<Props, State> {
  override state: State = { hasError: false };

  static getDerivedStateFromError(): State {
    return { hasError: true };
  }

  override componentDidCatch(error: unknown, info: { componentStack?: string | null }): void {
    log.error(`component tree crashed${info.componentStack ? `\n${info.componentStack}` : ""}`, error);
  }

  override render(): ReactNode {
    if (this.state.hasError) {
      return (
        <div className="flex h-screen flex-col items-center justify-center gap-4 font-sans">
          <p className="text-lg font-medium">Something went wrong.</p>
          <button
            type="button"
            className="rounded-md border border-border px-4 py-2 text-sm hover:bg-accent"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      );
    }
    return this.props.children;
  }
}
```

（fallback 文案不走 i18n：boundary 触发时 i18n 自身可能已不可用，硬编码英文最稳。）

- [ ] **Step 3: renderer.tsx 接线**

在 `src/renderer.tsx` 中：import 区追加，`createRoot` 调用前挂全局钩子，render 树包 ErrorBoundary：

```typescript
import { ErrorBoundary } from "@renderer/ErrorBoundary";
import { createLogger } from "@renderer/logger";

// 全局错误 funnel：组件生命周期之外的错误也留痕（boundary 只覆盖渲染树内）
const windowLog = createLogger("window");
window.onerror = (message, source, lineno, colno, error) => {
  windowLog.error(`${String(message)} (${source ?? "?"}:${lineno ?? 0}:${colno ?? 0})`, error);
};
window.addEventListener("unhandledrejection", (ev) => {
  windowLog.error("unhandled promise rejection", ev.reason);
});
```

render 部分改为：

```typescript
createRoot(rootEl).render(
  <StrictMode>
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <App />
      </QueryClientProvider>
    </ErrorBoundary>
  </StrictMode>,
);
```

- [ ] **Step 4: 验证 + Commit**

Run: `pnpm typecheck && pnpm lint`
Expected: 干净。

```bash
git add src/renderer/logger/ src/renderer/ErrorBoundary.tsx src/renderer.tsx
git commit -m "feat(renderer): add logger with devtools echo and global error funnel"
```

---

### Task 5: 主进程 console 调用点替换 + process 钩子

逐文件把 `console.warn/error` 换成模块 logger。**改动模式统一**：文件顶部 `import { createLogger } from "@main/logger";`（或相对路径）+ 模块级 `const log = createLogger("<module>");`，调用点 `console.error("[x] msg:", err)` → `log.error("msg", err)`（**前缀 `[xxx]` 从消息里去掉**——module 段已携带）。

**Files & module 名分配:**

| 文件                                  | 处数 | module                                          | 现调用（行号供参考，以 grep 为准）    |
| ------------------------------------- | ---- | ----------------------------------------------- | ------------------------------------- |
| `src/main.ts`                         | 3    | `window`（loadURL/loadFile）、`db`（init 失败） | L66/L72/L105 console.error            |
| `src/main/ipc/registry.ts`            | 1    | `ipc`                                           | L28 console.error                     |
| `src/main/chat/messages.ts`           | 1    | `chat`                                          | L21 console.warn                      |
| `src/main/chat/conversation-title.ts` | 2    | `chat`                                          | L67/L93 console.warn                  |
| `src/main/library/book-files.ts`      | 1    | `library`                                       | L59 console.warn                      |
| `src/main/library/repository.ts`      | 1    | `library`                                       | L94 console.warn                      |
| `src/main/ai/send.ts`                 | 2    | `send`                                          | L149/L207 console.warn                |
| `src/main/ai/summary.ts`              | 5    | `summary`                                       | L115/L122/L206/L217/L221 console.warn |
| `src/main/ipc/library-handlers.ts`    | 2    | `library`                                       | L116/L131 console.warn                |
| `src/main/secrets/ai-sdk-tester.ts`   | 1    | `providers`                                     | L79 console.warn                      |

- [ ] **Step 1: 逐文件替换**

每个文件：加 import 与 `const log = createLogger("...")`，替换调用。例（send.ts）：

```typescript
// 旧：
console.warn("[send] stream/model error:", err);
// 新（文件顶部已有 const log = createLogger("send")）：
log.warn("stream/model error", err);
```

main.ts 的三处分别用 `createLogger("window")`（两处加载失败）与 `createLogger("db")`（init 失败）——可建两个模块级常量。

- [ ] **Step 2: main.ts 挂 process 钩子**

`initAppService({...})` 调用之后追加：

```typescript
// 主进程兜底错误钩子：未捕获异常/拒绝必须留痕（fail-fast 崩溃前的最后一笔日志）
const processLog = createLogger("process");
process.on("uncaughtException", (err) => {
  processLog.error("uncaught exception", err);
});
process.on("unhandledRejection", (reason) => {
  processLog.error("unhandled rejection", reason);
});
```

注意：`process.on("uncaughtException")` 注册后 Node 默认的「打印并退出」行为会被取代——为保持 fail-fast 崩溃语义，在 handler 末尾补 `process.exit(1)`：

```typescript
process.on("uncaughtException", (err) => {
  processLog.error("uncaught exception", err);
  process.exit(1); // 保持 fail-fast：留痕后照常崩溃，不带病运行
});
```

（`unhandledRejection` 不退出——Node 默认也只是 warning；留痕即可。）

- [ ] **Step 3: 残留检查 + 验证**

```bash
grep -rn "console\.\(warn\|error\)" src/main/ --include="*.ts" | grep -v "\.test\.ts" | grep -v "logger-service.ts"
```

Expected: 零命中（logger-service.ts 自身的 console 输出是双写机制，排除）。

Run: `pnpm typecheck && pnpm test`
Expected: 全绿。注意：若有测试 spy/断言了被替换文件的 console 输出（grep 测试文件确认），按新行为修正断言。

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "refactor(main): route console diagnostics through LoggerService"
```

---

### Task 6: 设置页 advanced 分类 + 打开日志文件夹 + i18n

**Files:**

- Modify: `src/renderer/store/settings-store.ts:3`
- Modify: `src/renderer/settings/SettingsShell.tsx`
- Create: `src/renderer/settings/AdvancedSettings.tsx`
- Modify: `src/shared/i18n/locales/en.ts`、`src/shared/i18n/locales/zh-CN.ts`

- [ ] **Step 1: settings-store.ts 扩类型**

```typescript
// 旧（L3）：
export type SettingsCategory = "models" | "appearance" | "reading";
// 新：
export type SettingsCategory = "models" | "appearance" | "reading" | "advanced";
```

- [ ] **Step 2: 创建 AdvancedSettings.tsx**

```typescript
import { useTranslation } from "react-i18next";
import { FolderOpen } from "lucide-react";
import { Button } from "@renderer/components/ui/button";

export function AdvancedSettings() {
  const { t } = useTranslation();
  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg">{t("settings.advanced", "高级")}</h2>
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium">{t("settings.logs", "日志")}</span>
        <Button variant="outline" size="sm" onClick={() => void window.api.app.openLogsDir()}>
          <FolderOpen />
          {t("settings.openLogsFolder", "打开日志文件夹")}
        </Button>
      </div>
    </section>
  );
}
```

（实现前先看 `AppearanceSettings.tsx` 的行布局惯例，按现状对齐 className——以上是基于勘察的合理近似，存在出入以现有组件风格为准。）

- [ ] **Step 3: SettingsShell.tsx 接入**

CATEGORIES 数组（L19-23）追加：

```typescript
  { key: "advanced", label: t("settings.advanced", "高级") },
```

内容渲染区（L70-75 的条件渲染链）追加：

```typescript
    {active === "advanced" && <AdvancedSettings />}
```

顶部 import：

```typescript
import { AdvancedSettings } from "./AdvancedSettings";
```

- [ ] **Step 4: i18n key 同步**

先跑 `pnpm i18n:extract`（把组件里的新 key 同步进 en.ts——extract 配置会以 t() 的 fallback 填充主语言；本项目 fallback 写的是中文，故 **extract 后手动把 en.ts 的三个新值改为英文**），再手动在 `zh-CN.ts` 对应位置加中文：

| key                       | en.ts              | zh-CN.ts         |
| ------------------------- | ------------------ | ---------------- |
| `settings.advanced`       | `Advanced`         | `高级`           |
| `settings.logs`           | `Logs`             | `日志`           |
| `settings.openLogsFolder` | `Open logs folder` | `打开日志文件夹` |

然后 `pnpm i18n:lint` 确认无缺漏（lint 有漏报史——再 `grep -n "settings.advanced" src/shared/i18n/locales/*.ts` 双确认两文件都有）。

- [ ] **Step 5: 验证 + Commit**

Run: `pnpm typecheck && pnpm test && pnpm lint`
Expected: 全绿。

```bash
git add -A
git commit -m "feat(settings): add advanced category with open-logs-folder entry"
```

---

### Task 7: 全量验证 + dev 冒烟

- [ ] **Step 1: 全量门禁**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: 全绿。

- [ ] **Step 2: dev 冒烟**

```bash
(pnpm start > /tmp/marginalia-logger-smoke.log 2>&1 &) ; sleep 30
grep -E "\[main\] \[(info|warn|error)\]" /tmp/marginalia-logger-smoke.log | head -5
ls "$HOME/Library/Application Support/marginalia-dev/logs/"
cat "$HOME/Library/Application Support/marginalia-dev/logs/main-"*.log | head -10
ps aux | grep -i electron | grep marginalia   # 找本项目 PID 后精确 kill（勿宽杀）
```

Expected:

- stdout 出现四段式日志行（启动期若无日志可在 DevTools console 跑 `window.api.log.write({level:"info",module:"smoke",message:"hi"})` 验证 renderer 链路 → `renderer-*.log` 生成且 main 终端**无**回显该行）
- `logs/` 目录存在且含当日 `main-*.log`

杀进程只匹配本项目路径，绝不宽杀 electron（别的 worktree 可能在跑）。

- [ ] **Step 3: 收尾 commit（如冒烟过程产生修正）**

```bash
git add -A && git commit -m "fix(logger): <发现的问题>"   # 仅在有修正时
```

---

## 完成定义

- [ ] 全部 Task commit；`pnpm typecheck && pnpm lint && pnpm test` 全绿
- [ ] `grep -rn "console\.\(warn\|error\)" src/main/ --include="*.ts" | grep -v test | grep -v logger-service` 零命中
- [ ] 两个 barrel 导出面测试在（logger 仅 `createLogger`）
- [ ] dev 冒烟：`main-*.log` 生成、四段式格式正确、renderer 链路落 `renderer-*.log` 且不回显 main stdout
- [ ] 设置页「高级」分类可打开日志文件夹
- 打包验证（spec §8：`pnpm package` 产物 `--user-data-dir=/tmp/<x>` 冒烟、确认 `logs/main-<当日>.log` 生成）**留待交付/合并前**执行——不在本计划任务内，finishing 流程勿忘
