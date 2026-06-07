# AppService（Electron API 抽象层）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 `src/main/app/` 的 AppService——Electron API 的端口-适配器抽象，`main.ts` 注入环境（fail-fast），无头模块经 `appService.env` 消费，vitest 全局 setup 保证测试同构。

**Architecture:** AppService 类 + 模块内单例（类不导出），`initAppService` 导出但不进 barrel（仅 `main.ts`/测试深导入），barrel 仅 re-export `appService`。`env` getter 类型无 null——未注入即访问直接 throw（fail-fast）；生产由 `main.ts` 启动注入、测试由 vitest `setupFiles` 注入，「恒可用」是全局不变量。Spec：`docs/superpowers/specs/2026-06-07-app-service-design.md`。

**Tech Stack:** TypeScript 6（strict）、vitest 4（`ELECTRON_RUN_AS_NODE=1` 跑在 Electron 运行时）、Electron 41。

**File structure:**

```
src/main/app-info.ts            # Task 1: 由 src/main/app-service.ts 改名（getAppInfo/ping 纯函数）
src/main/app-info.test.ts       # Task 1: 由 src/main/app-service.test.ts 改名
src/main/ipc/app-handlers.ts    # Task 1: import 路径同步
src/main/app/app-service.ts     # Task 2: AppServiceEnv + AppService 类（不导出）+ 单例 + initAppService + appService
src/main/app/app-service.test.ts# Task 2/3: 单测
src/main/app/index.ts           # Task 3: barrel，仅 re-export appService
vitest.setup.ts                 # Task 4: 全局注入测试 env
vitest.config.ts                # Task 4: 加 setupFiles
src/main.ts                     # Task 5: 注入接线
```

注意：本仓库 pre-commit hook（prek）跑 `lint:fix` + `format`，若提示 "files were modified by this hook"，重新 `git add` 被改文件后再执行同一条 commit 命令即可（第二次会过）。

---

### Task 1: 改名 app-service.ts → app-info.ts（为新模块腾名字）

现有 `src/main/app-service.ts` 是 `getAppInfo`/`ping` IPC 业务纯函数，与新 AppService 撞名。改名 `app-info.ts`（名实相符），同步两个引用方。

**Files:**

- Rename: `src/main/app-service.ts` → `src/main/app-info.ts`
- Rename: `src/main/app-service.test.ts` → `src/main/app-info.test.ts`
- Modify: `src/main/ipc/app-handlers.ts:4`

- [ ] **Step 1: git mv 两个文件**

```bash
git mv src/main/app-service.ts src/main/app-info.ts
git mv src/main/app-service.test.ts src/main/app-info.test.ts
```

- [ ] **Step 2: 更新 app-handlers.ts 的 import**

`src/main/ipc/app-handlers.ts` 第 4 行：

```typescript
// 旧：
import { getAppInfo, ping } from "@main/app-service";
// 新：
import { getAppInfo, ping } from "@main/app-info";
```

- [ ] **Step 3: 更新 app-info.test.ts 的 import 与 describe 名**

`src/main/app-info.test.ts` 第 5 行 import 与第 9 行 describe：

```typescript
// 旧（L5）：
import { getAppInfo, ping } from "@main/app-service";
// 新：
import { getAppInfo, ping } from "@main/app-info";

// 旧（L9）：
describe("app-service", () => {
// 新：
describe("app-info", () => {
```

- [ ] **Step 4: 验证**

Run: `pnpm typecheck && pnpm test src/main/app-info.test.ts`
Expected: typecheck 无错误；测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor(main): rename app-service to app-info to free the name"
```

---

### Task 2: AppService 核心（TDD）

**Files:**

- Create: `src/main/app/app-service.ts`
- Create: `src/main/app/app-service.test.ts`

- [ ] **Step 1: 写失败测试**

创建 `src/main/app/app-service.test.ts`：

```typescript
import { describe, expect, it, vi } from "vitest";
import { appService, initAppService, type AppServiceEnv } from "./app-service";

function makeEnv(overrides: Partial<AppServiceEnv> = {}): AppServiceEnv {
  return {
    dataDir: "/tmp/app-service-test",
    isDev: false,
    openFolder: async () => {},
    ...overrides,
  };
}

describe("app-service", () => {
  it("throws on env access before initialization (fail-fast)", async () => {
    // 顶部静态 import 的单例可能已被全局 setup 注入（Task 4 之后）；
    // 用 resetModules + 动态 import 构造全新未注入实例来测 fail-fast。
    vi.resetModules();
    const fresh = await import("./app-service");
    expect(() => fresh.appService.env).toThrow(/not initialized/);
  });

  it("returns the injected env after initialization", () => {
    const env = makeEnv();
    initAppService(env);
    expect(appService.env).toBe(env);
  });

  it("last injection wins on repeated init", () => {
    initAppService(makeEnv({ dataDir: "/tmp/first" }));
    initAppService(makeEnv({ dataDir: "/tmp/second" }));
    expect(appService.env.dataDir).toBe("/tmp/second");
  });

  it("invokes the injected openFolder capability with the given dir", async () => {
    const openFolder = vi.fn(async () => {});
    initAppService(makeEnv({ openFolder }));
    await appService.env.openFolder("/some/dir");
    expect(openFolder).toHaveBeenCalledWith("/some/dir");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/app/app-service.test.ts`
Expected: FAIL——`Cannot find module './app-service'`（或等价的模块解析错误）。

- [ ] **Step 3: 最小实现**

创建 `src/main/app/app-service.ts`：

```typescript
/**
 * AppService：Electron API 的抽象层（端口-适配器中的端口）。
 * 本模块不 import electron——main.ts 注入环境值与能力实现（适配器），
 * 业务/基础设施模块面向本抽象编程，整条依赖链无头可测。
 * Spec: docs/superpowers/specs/2026-06-07-app-service-design.md
 */

/** main.ts 注入的运行环境实现。字段平台无关——不绑 Electron 术语 */
export interface AppServiceEnv {
  /** 应用数据根目录（Electron 适配 = app.getPath("userData")） */
  dataDir: string;
  /** 是否开发模式（Electron 适配 = !app.isPackaged） */
  isDev: boolean;
  /** 在系统文件管理器中打开目录（Electron 适配 = shell.openPath，吞掉其 string 返回值） */
  openFolder: (dir: string) => Promise<void>;
}

/** 类不导出：消费方只能经 barrel 拿 appService，无法绕过封装 */
class AppService {
  #env: AppServiceEnv | null = null;

  /** 重复注入 last-wins：测试内按需重新注入依赖此语义 */
  init(env: AppServiceEnv): void {
    this.#env = env;
  }

  /**
   * 恒可用是全局不变量：生产由 main.ts 启动注入保证（失败即崩），
   * 测试由 vitest 全局 setup 注入保证。未注入即访问 = 初始化顺序 bug，fail-fast。
   */
  get env(): AppServiceEnv {
    if (!this.#env) {
      throw new Error("AppService not initialized — initAppService must run before any consumer");
    }
    return this.#env;
  }
}

const service = new AppService();

/** 生命周期钩子：仅 main.ts 与测试（vitest setup / 单测重注入）深导入调用，不进 barrel */
export function initAppService(env: AppServiceEnv): void {
  service.init(env);
}

/** 只读单例——barrel 唯一导出。env 类型无 null：一次拿到完整环境，全字段 required */
export const appService: { readonly env: AppServiceEnv } = service;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/app/app-service.test.ts`
Expected: 4 个测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/app/app-service.ts src/main/app/app-service.test.ts
git commit -m "feat(main): add AppService electron abstraction port"
```

---

### Task 3: barrel（TDD）

**Files:**

- Create: `src/main/app/index.ts`
- Modify: `src/main/app/app-service.test.ts`（追加导出面断言）

- [ ] **Step 1: 追加失败测试**

在 `src/main/app/app-service.test.ts` 顶部追加 import，文件末尾（`describe("app-service", ...)` 块之后）追加：

```typescript
// 文件顶部追加：
import * as barrel from "./index";

// 文件末尾追加：
describe("app barrel", () => {
  it("exposes only appService (encapsulation does not leak)", () => {
    expect(Object.keys(barrel).sort()).toEqual(["appService"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/app/app-service.test.ts`
Expected: FAIL——`Cannot find module './index'`（或等价错误）。

- [ ] **Step 3: 创建 barrel**

创建 `src/main/app/index.ts`：

```typescript
/** barrel：仅 re-export appService——消费方唯一入口。
 * initAppService 有意不进 barrel（生命周期钩子，仅 main.ts/测试深导入 app/app-service）。 */
export { appService } from "./app-service";
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/app/app-service.test.ts`
Expected: 5 个测试全 PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/app/index.ts src/main/app/app-service.test.ts
git commit -m "feat(main): add app barrel exposing only appService"
```

---

### Task 4: vitest 全局 setup 注入

「恒可用」不变量在测试中的保证：所有测试进程启动即注入测试 env，后续消费者（如 LoggerService）的测试与生产同构、无需各自 mock。

**Files:**

- Create: `vitest.setup.ts`（仓库根，与 vitest.config.ts 并排）
- Modify: `vitest.config.ts`

- [ ] **Step 1: 创建 vitest.setup.ts**

```typescript
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initAppService } from "./src/main/app/app-service";

// 「AppService 恒可用」全局不变量（fail-fast spec）：测试与生产同构——
// 每个测试 worker 启动即注入测试 env，消费方测试无需 mock、不存在降级分支。
initAppService({
  dataDir: mkdtempSync(path.join(tmpdir(), "marginalia-test-")), // 每 worker 独立 tmp 目录，互不冲突
  isDev: false, // 测试输出保持安静（后续 logger 的 dev console 双写不触发）
  openFolder: async () => {},
});
```

- [ ] **Step 2: vitest.config.ts 注册 setupFiles**

`vitest.config.ts` 的 `test` 块（当前 L12-16）：

```typescript
  test: {
    environment: "node",
    globals: true,
    include: ["src/**/*.test.ts", "packages/*/src/**/*.test.ts"],
    setupFiles: ["./vitest.setup.ts"],
  },
```

- [ ] **Step 3: 全量测试验证**

Run: `pnpm test`
Expected: 全部 PASS（含 Task 2/3 的 5 个新测试；`throws before initialization` 用例因走 resetModules 全新实例，不受全局注入影响仍 PASS）。

- [ ] **Step 4: Commit**

```bash
git add vitest.setup.ts vitest.config.ts
git commit -m "test: inject AppService env via vitest global setup"
```

---

### Task 5: main.ts 注入接线（生产 fail-fast）

**Files:**

- Modify: `src/main.ts`（import 区 + L20-22 `setName` 块之后）

- [ ] **Step 1: 加 import**

`src/main.ts` import 区（现有 L4 `initDb` import 附近）追加：

```typescript
import { initAppService } from "@main/app/app-service";
```

（深导入 `app/app-service` 而非 barrel `app`——initAppService 有意不进 barrel。）

- [ ] **Step 2: setName 块后注入**

现有代码（L18-22）：

```typescript
// dev 与 production 各用独立的 userData 目录（分库，避免两环境互相污染数据）。
// 必须在任何 app.getPath("userData") 调用前生效（instance.ts 在 app.ready 才首次读取）。
if (!app.isPackaged) {
  app.setName(`${app.getName()}-dev`); // marginalia → marginalia-dev
}
```

紧随其后插入（**不包 try/catch**——`app.getPath` 若抛错即未捕获崩溃，正是 fail-fast 要的行为）：

```typescript
// AppService 注入：Electron 环境/能力的适配器实现止步于此（业务面向 appService.env 抽象）。
// 必须在 setName 之后（dataDir 跟随 dev/prod 隔离）、一切消费方之前；
// fail-fast——初始化失败直接崩，不带病运行，下游消费零判空零降级。
initAppService({
  dataDir: app.getPath("userData"),
  isDev: !app.isPackaged,
  openFolder: async (dir) => {
    await shell.openPath(dir); // 错误信息字符串在适配器层吞掉——打开文件夹失败不致命
  },
});
```

（`shell` 已在 L1 `import { app, BrowserWindow, net, shell } from "electron"` 中。）

- [ ] **Step 3: 验证**

Run: `pnpm typecheck && pnpm test`
Expected: typecheck 无错误；全量测试 PASS。

- [ ] **Step 4: dev 冒烟（可选但推荐）**

Run: `pnpm start`（阻塞；启动成功看到主窗口、终端无 `AppService not initialized` 报错即可 Ctrl+C 退出）
Expected: 应用正常启动——注入发生在模块求值早期，先于一切消费方。

- [ ] **Step 5: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): wire AppService injection at startup"
```

---

## 完成定义

- [ ] 5 个 Task 全部 commit
- [ ] `pnpm typecheck` 与 `pnpm test` 全绿
- [ ] `src/main/app/app-service.ts` 不含 `from "electron"` import（`grep -n 'from "electron"' src/main/app/*.ts` 应零命中）
- [ ] barrel 导出面测试在（仅 `appService`）
