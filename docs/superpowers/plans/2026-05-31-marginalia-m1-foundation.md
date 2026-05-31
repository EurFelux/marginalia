# Marginalia MA1 · main 侧地基（Foundation）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 建立 **main 侧** 的 SQLite(Drizzle)+迁移、`shared/` 的 Zod 单一事实源，以及一条 Zod 校验的 IPC 脊柱（handler 业务逻辑可 headless 用 vitest 测试，并经 preload 暴露 `window.api` 契约）。renderer 暂保持模板占位，**不建真实 UI**。vitest 全绿。

**Architecture:** 厚 main / 薄 renderer。本里程碑只做 main 侧：DB（Drizzle over better-sqlite3）、IPC handler（入参经 Zod 校验，业务逻辑抽成纯函数以便 headless 测试）、`shared/` 放跨进程的 Zod schema 与 `z.infer` 类型。renderer 的真实 UI 走"原型轨"（见下）。

**Tech Stack:** Electron Forge + Vite 8、TypeScript 6、Drizzle ORM + better-sqlite3 + drizzle-kit、Zod、uuid(v7)、vitest（Node 环境）、oxlint/oxfmt（prek 预提交）。

---

## 开发工作流（用户既定）

1. **main 侧核心先独立开发**（headless，vitest 覆盖）：DB、IPC 契约、ePub 解析、AI 编排、工具、摘要队列——全部以 `shared/` 的 `window.api` 契约对外。
2. **UI/UX 先在 `packages/ui-prototype` 做原型，经用户确认。**
3. 确认后再**移植进主应用 renderer**，对接已就绪的 `window.api`。

### 里程碑 · main 侧核心轨

- **MA1 · 地基**（本文件）：DB + 迁移 + shared Zod 契约 + 校验的 IPC 脊柱（headless 测试）。
- MA2 · ePub + 内容仓库：导入解析（OPF/NCX/spine → books/chapters）、进度仓库、按章原文读取、原文只读工具（`getToc` / `readChapterText` / `getChapterSummary`）。
- MA3 · Provider + 密钥：providers 仓库、safeStorage 加解密、掩码/揭示/测试连接。
- MA4 · AI 编排：会话/章节路由、chips 组装、prompt 组装、`streamText` + 工具 agent 循环、UIMessage 落库、章节摘要懒生成队列——经 IPC 暴露。

### UI 原型轨（在 `packages/ui-prototype`，每步经用户确认）

- UP1 · 书库 + 阅读器布局；UP2 · 选区工具栏 + chips + AI 面板（流式/工具步骤展示）；UP3 · 设置（Provider/Assistant/阅读偏好）。

### 集成轨

- UI 原型确认后，逐块移植进主应用 renderer（React + Tailwind v4 + shadcn Base UI）并接 `window.api`。

设计依据：`docs/superpowers/specs/2026-05-31-marginalia-core-reading-loop-design.md`。

---

## 已知约束（开工前务必知道）

1. **better-sqlite3 是原生模块，ABI 双轨**：`pnpm install` 默认按 **Node ABI** 构建（vitest 在 Node 跑，能用）；`pnpm start`（electron-forge）会按 **Electron ABI** 重建它。**跑过 app 后再跑 vitest 会报 ABI 不匹配**——切换回测试前执行 `pnpm db:rebuild:node`（本计划会加该脚本）。
2. **prek 预提交会自动改文件**：`git commit` 触发的 `lint:fix`/`format`（oxfmt）会重排被提交文件并**中断本次提交**。出现 "files were modified by this hook" 时，**重新 `git add` 同一批文件再 `git commit`**（第二次通过）。
3. **pnpm 原生构建白名单**：better-sqlite3 须加入 `package.json` 的 `pnpm.onlyBuiltDependencies`，否则不会构建原生部分。
4. 全程用 `pnpm`/`pnpx`（不要 `npx`）。
5. **本里程碑不动 renderer 的真实 UI**：保留模板的 `index.html` / `src/renderer.ts`，仅让 app 能启动；IPC 一律靠 vitest 验证业务逻辑、靠 `pnpm start` 确认注册无报错。

---

## MA1 文件结构（创建/修改一览）

**配置（修改）**

- `tsconfig.json` — 路径别名 / strict / moduleResolution（不加 jsx，UI 阶段再加）
- `vite.main.config.ts` — 别名（@shared/@main）
- `vite.preload.config.ts` — 别名（@shared）
- `vitest.config.ts`（创建）— Node 环境 + 别名
- `drizzle.config.ts`（创建）
- `package.json` — 依赖 + 脚本 + onlyBuiltDependencies

**shared（创建）**

- `src/shared/types.ts` — 跨进程领域类型 + `messageMetadataSchema`
- `src/shared/ipc.ts` — IPC 通道名 + Zod schema + `z.infer` 类型
- `src/shared/ipc.test.ts`

**main（创建）**

- `src/main/db/schema.ts` — 全部 Phase-1 表
- `src/main/db/client.ts` — 连接 + 迁移执行
- `src/main/db/instance.ts` — DB 单例（initDb/getDb）
- `src/main/db/migrations/*` — drizzle-kit 生成
- `src/main/db/client.test.ts`
- `src/main/ipc/validate.ts` + `validate.test.ts`
- `src/main/ipc/registry.ts` — `ipcMain.handle` + Zod 包装
- `src/main/app-service.ts` — handler 业务逻辑（纯函数，可测）+ `app-service.test.ts`
- `src/main/ipc/app-handlers.ts` — 注册 handlers
- `src/preload.ts`（修改）— contextBridge 暴露 `window.api`
- `src/main.ts`（修改）— ready 时 initDb + 注册 handlers

> renderer：本里程碑**保持模板不变**（`index.html`、`src/renderer.ts`、`src/index.css`）。

---

## Task 1: 测试基建 + shared Zod 契约

**Files:**

- Modify: `package.json`（zod、@types/node、脚本）、`tsconfig.json`、`vite.main.config.ts`、`vite.preload.config.ts`
- Create: `vitest.config.ts`、`src/shared/types.ts`、`src/shared/ipc.ts`、`src/shared/ipc.test.ts`

- [ ] **Step 1: 安装依赖**

```bash
pnpm add zod
pnpm add -D @types/node
```

- [ ] **Step 2: 更新 `tsconfig.json`（全量替换）**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "lib": ["ESNext", "DOM", "DOM.Iterable"],
    "allowJs": true,
    "skipLibCheck": true,
    "esModuleInterop": true,
    "strict": true,
    "noImplicitAny": true,
    "sourceMap": true,
    "resolveJsonModule": true,
    "noEmit": true,
    "baseUrl": ".",
    "paths": {
      "@shared/*": ["src/shared/*"],
      "@main/*": ["src/main/*"]
    },
    "types": ["node"]
  },
  "include": ["src", "*.config.ts", "forge.config.ts", "forge.env.d.ts"]
}
```

> UI 移植阶段再补 `"jsx": "react-jsx"` 与 `@/*` 别名。

- [ ] **Step 3: 配置 main/preload vite 别名**

`vite.main.config.ts`（全量替换）：

```ts
import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@shared", replacement: path.resolve(__dirname, "src/shared") },
      { find: "@main", replacement: path.resolve(__dirname, "src/main") },
    ],
  },
});
```

`vite.preload.config.ts`（全量替换）：

```ts
import { defineConfig } from "vite";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [{ find: "@shared", replacement: path.resolve(__dirname, "src/shared") }],
  },
});
```

- [ ] **Step 4: 创建 `vitest.config.ts`（Node 环境）**

```ts
import { defineConfig } from "vitest/config";
import path from "node:path";

export default defineConfig({
  resolve: {
    alias: [
      { find: "@shared", replacement: path.resolve(__dirname, "src/shared") },
      { find: "@main", replacement: path.resolve(__dirname, "src/main") },
    ],
  },
  test: {
    environment: "node",
    globals: true,
  },
});
```

- [ ] **Step 5: 在 `package.json` 的 `scripts` 加入测试脚本**

```json
    "test": "vitest run",
    "test:watch": "vitest"
```

- [ ] **Step 6: 创建 `src/shared/types.ts`**

```ts
import { z } from "zod";

/** ePub 目录树节点（books.toc 的元素） */
export interface TocNode {
  label: string;
  href: string;
  children?: TocNode[];
}

/** 消息附带的 app 元数据（存入 UIMessage.metadata） */
export const messageMetadataSchema = z.object({
  contextChips: z
    .array(
      z.object({
        id: z.enum(["selection", "paragraph"]),
        content: z.string(),
        tokenCount: z.number().int().nonnegative(),
      }),
    )
    .optional(),
  model: z.string().optional(),
  usage: z
    .object({
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })
    .optional(),
});

export type MessageMetadata = z.infer<typeof messageMetadataSchema>;
```

- [ ] **Step 7: 写失败测试 `src/shared/ipc.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { appGetInfoResult, IPC, pingInput } from "@shared/ipc";

describe("ipc schemas", () => {
  it("exposes channel names", () => {
    expect(IPC.appGetInfo).toBe("app:get-info");
    expect(IPC.ping).toBe("ping");
  });

  it("ping input rejects non-string msg", () => {
    expect(pingInput.safeParse({ msg: 123 }).success).toBe(false);
    expect(pingInput.safeParse({ msg: "hi" }).success).toBe(true);
  });

  it("app info result requires version + bookCount", () => {
    expect(appGetInfoResult.safeParse({ version: "1.0.0", bookCount: 0 }).success).toBe(true);
    expect(appGetInfoResult.safeParse({ version: "1.0.0" }).success).toBe(false);
  });
});
```

- [ ] **Step 8: 运行测试（验证失败）**

Run: `pnpm test src/shared/ipc.test.ts`
Expected: FAIL —— `@shared/ipc` 不存在。

- [ ] **Step 9: 创建 `src/shared/ipc.ts`**

```ts
import { z } from "zod";

/** IPC 通道名（main 注册 / preload 调用 共用） */
export const IPC = {
  appGetInfo: "app:get-info",
  ping: "ping",
} as const;

/** ping —— 演示"带入参且经 Zod 校验"的往返 */
export const pingInput = z.object({ msg: z.string().min(1) });
export type PingInput = z.infer<typeof pingInput>;
export const pingResult = z.object({ echo: z.string() });
export type PingResult = z.infer<typeof pingResult>;

/** app:get-info —— 无入参，返回版本与书数 */
export const appGetInfoResult = z.object({
  version: z.string(),
  bookCount: z.number().int().nonnegative(),
});
export type AppGetInfoResult = z.infer<typeof appGetInfoResult>;
```

- [ ] **Step 10: 运行测试（验证通过）+ 类型检查**

Run: `pnpm test src/shared/ipc.test.ts`
Expected: PASS（3 断言）。

Run: `pnpm typecheck`
Expected: 无报错。

- [ ] **Step 11: 提交**

```bash
git add -A
git commit -m "chore(ma1): vitest(node) + shared Zod schemas (ipc + message metadata)"
```

> 若 prek 报 "files were modified by this hook"：再 `git add -A && git commit -m "..."`（见"已知约束 2"）。

---

## Task 2: Drizzle schema（全部 Phase-1 表）+ 生成迁移

**Files:**

- Create: `src/main/db/schema.ts`、`drizzle.config.ts`、`src/main/db/migrations/*`（生成）
- Modify: `package.json`（drizzle-kit、better-sqlite3、uuid、脚本、onlyBuiltDependencies）

- [ ] **Step 1: 安装依赖**

```bash
pnpm add better-sqlite3 uuid
pnpm add -D drizzle-kit @types/better-sqlite3 @types/uuid
```

- [ ] **Step 2: better-sqlite3 加入 pnpm 构建白名单 + 构建**

编辑 `package.json` 的 `pnpm.onlyBuiltDependencies`，加入 `"better-sqlite3"`：

```json
  "pnpm": {
    "onlyBuiltDependencies": [
      "electron",
      "electron-winstaller",
      "better-sqlite3"
    ]
  }
```

Run: `pnpm rebuild better-sqlite3`
Expected: 原生构建成功（Node ABI）。

- [ ] **Step 3: 创建 `src/main/db/schema.ts`**

```ts
import { blob, integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { v7 as uuidv7 } from "uuid";
import type { UIMessage } from "ai";
import type { MessageMetadata, TocNode } from "@shared/types";

const pkUuid = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());
const nowMs = () =>
  integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now());

export const providers = sqliteTable("providers", {
  id: pkUuid(),
  type: text("type", {
    enum: ["openai", "anthropic", "google", "openai-compatible"],
  }).notNull(),
  label: text("label"),
  baseUrl: text("base_url"),
  apiKeyEncrypted: blob("api_key_encrypted", { mode: "buffer" }),
  createdAt: nowMs(),
});

export const assistants = sqliteTable("assistants", {
  id: pkUuid(),
  name: text("name").notNull(),
  systemPrompt: text("system_prompt"),
  providerId: text("provider_id").references(() => providers.id),
  model: text("model"),
  createdAt: nowMs(),
});

export const books = sqliteTable("books", {
  id: text("id").primaryKey(), // ePub 自然键（缺失回退文件哈希）
  path: text("path").notNull(),
  title: text("title"),
  author: text("author"),
  cover: blob("cover", { mode: "buffer" }),
  toc: text("toc", { mode: "json" }).$type<TocNode[]>(),
  addedAt: integer("added_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const chapters = sqliteTable("chapters", {
  id: text("id").primaryKey(), // spine item id（自然键）
  bookId: text("book_id")
    .notNull()
    .references(() => books.id),
  title: text("title"),
  orderIndex: integer("order_index"),
  href: text("href"),
  summary: text("summary"),
  summaryStatus: text("summary_status", {
    enum: ["pending", "generating", "ready", "unavailable"],
  })
    .notNull()
    .default("pending"),
});

export const progress = sqliteTable("progress", {
  bookId: text("book_id")
    .primaryKey()
    .references(() => books.id),
  cfi: text("cfi").notNull(),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const conversations = sqliteTable("conversations", {
  id: pkUuid(),
  bookId: text("book_id").references(() => books.id),
  chapterId: text("chapter_id").references(() => chapters.id), // NULL = 独立会话
  assistantId: text("assistant_id").references(() => assistants.id),
  title: text("title"),
  createdAt: nowMs(),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const messages = sqliteTable("messages", {
  id: pkUuid(),
  conversationId: text("conversation_id")
    .notNull()
    .references(() => conversations.id),
  role: text("role", { enum: ["system", "user", "assistant"] }).notNull(),
  parts: text("parts", { mode: "json" }).$type<UIMessage["parts"]>().notNull(),
  metadata: text("metadata", { mode: "json" }).$type<MessageMetadata>(),
  seq: integer("seq").notNull(),
  createdAt: nowMs(),
});
```

- [ ] **Step 4: 创建 `drizzle.config.ts`**

```ts
import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./src/main/db/schema.ts",
  out: "./src/main/db/migrations",
});
```

- [ ] **Step 5: 在 `package.json` 的 `scripts` 加入 DB 脚本**

```json
    "db:generate": "drizzle-kit generate",
    "db:rebuild:node": "pnpm rebuild better-sqlite3"
```

- [ ] **Step 6: 生成迁移 + 类型检查**

Run: `pnpm db:generate`
Expected: `src/main/db/migrations/0000_*.sql` 与 `migrations/meta/` 生成；SQL 含 7 张表的 `CREATE TABLE`。

Run: `pnpm typecheck`
Expected: 无报错。

- [ ] **Step 7: 提交**

```bash
git add -A
git commit -m "feat(ma1): Drizzle schema for all Phase 1 tables + generated migration"
```

---

## Task 3: DB 连接 + 单例 + 启动迁移 + 仓库测试

**Files:**

- Create: `src/main/db/client.ts`、`src/main/db/instance.ts`、`src/main/db/client.test.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: 创建 `src/main/db/client.ts`**

```ts
import Database from "better-sqlite3";
import { drizzle, type BetterSQLite3Database } from "drizzle-orm/better-sqlite3";
import { migrate } from "drizzle-orm/better-sqlite3/migrator";
import * as schema from "@main/db/schema";

export type DB = BetterSQLite3Database<typeof schema>;

/** 打开（或新建）一个 SQLite 库并返回 Drizzle 实例。filename 传 ":memory:" 用于测试。 */
export function createDb(filename: string): DB {
  const sqlite = new Database(filename);
  sqlite.pragma("journal_mode = WAL");
  sqlite.pragma("foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

/** 应用 drizzle-kit 生成的迁移。 */
export function runMigrations(db: DB, migrationsFolder: string): void {
  migrate(db, { migrationsFolder });
}
```

- [ ] **Step 2: 写失败测试 `src/main/db/client.test.ts`**

```ts
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { providers } from "@main/db/schema";

const MIGRATIONS = path.resolve(__dirname, "migrations");

describe("db client", () => {
  it("runs migrations and round-trips a provider with a uuidv7 id", () => {
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);

    db.insert(providers).values({ type: "openai", label: "test" }).run();

    const rows = db.select().from(providers).where(eq(providers.type, "openai")).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].label).toBe("test");
    expect(rows[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });
});
```

- [ ] **Step 3: 运行测试（验证通过）**

Run: `pnpm db:rebuild:node && pnpm test src/main/db/client.test.ts`
Expected: PASS（迁移建表、插入、查询、uuidv7 格式断言通过）。
（若报 better-sqlite3 ABI 错误，是因为之前跑过 `pnpm start`；`db:rebuild:node` 已在命令里先重建为 Node ABI。）

- [ ] **Step 4: 创建 `src/main/db/instance.ts`（DB 单例）**

```ts
import path from "node:path";
import { app } from "electron";
import { createDb, runMigrations, type DB } from "@main/db/client";

let db: DB | undefined;

export function initDb(): DB {
  const dbPath = path.join(app.getPath("userData"), "marginalia.db");
  // 开发期迁移目录在源码树；打包期目录解析放到打包里程碑处理。
  const migrationsFolder = MAIN_WINDOW_VITE_DEV_SERVER_URL
    ? path.resolve(process.cwd(), "src/main/db/migrations")
    : path.join(__dirname, "db/migrations");
  db = createDb(dbPath);
  runMigrations(db, migrationsFolder);
  return db;
}

export function getDb(): DB {
  if (!db) throw new Error("DB not initialized");
  return db;
}
```

- [ ] **Step 5: 在 `src/main.ts` 接入 initDb**

顶部 import 区加入：

```ts
import { initDb } from "@main/db/instance";
```

把 `app.on("ready", createWindow);` 改为：

```ts
app.on("ready", () => {
  initDb();
  createWindow();
});
```

- [ ] **Step 6: 类型检查 + 启动验证**

Run: `pnpm typecheck`
Expected: 无报错。

Run: `pnpm start`
Expected: 启动后 forge 把 better-sqlite3 重建为 Electron ABI；`<userData>/marginalia.db` 被创建；控制台无迁移报错（窗口仍是模板页）。关闭窗口。

> ⚠️ 跑过 `pnpm start` 后再测，先 `pnpm db:rebuild:node`（见"已知约束 1"）。

- [ ] **Step 7: 提交**

```bash
pnpm db:rebuild:node && pnpm test
git add -A
git commit -m "feat(ma1): SQLite singleton + run migrations on app ready"
```

---

## Task 4: IPC 脊柱（headless 可测）

**Files:**

- Create: `src/main/ipc/validate.ts`、`src/main/ipc/validate.test.ts`、`src/main/ipc/registry.ts`、`src/main/app-service.ts`、`src/main/app-service.test.ts`、`src/main/ipc/app-handlers.ts`
- Modify: `src/preload.ts`、`src/main.ts`

- [ ] **Step 1: 写失败测试 `src/main/ipc/validate.test.ts`**

```ts
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { validateInput } from "@main/ipc/validate";

const schema = z.object({ msg: z.string().min(1) });

describe("validateInput", () => {
  it("returns parsed data on valid input", () => {
    expect(validateInput("ping", schema, { msg: "hi" })).toEqual({ msg: "hi" });
  });

  it("throws a channel-tagged error on invalid input", () => {
    expect(() => validateInput("ping", schema, { msg: 123 })).toThrow(/ping/);
  });
});
```

- [ ] **Step 2: 运行测试（验证失败）**

Run: `pnpm test src/main/ipc/validate.test.ts`
Expected: FAIL —— `@main/ipc/validate` 不存在。

- [ ] **Step 3: 创建 `src/main/ipc/validate.ts`**

```ts
import type { z } from "zod";

/** 校验 IPC 入参；非法即抛出带通道名的错误。 */
export function validateInput<T>(channel: string, schema: z.ZodType<T>, raw: unknown): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`IPC ${channel} invalid input: ${parsed.error.message}`);
  }
  return parsed.data;
}
```

- [ ] **Step 4: 运行测试（验证通过）**

Run: `pnpm test src/main/ipc/validate.test.ts`
Expected: PASS（2 断言）。

- [ ] **Step 5: 写失败测试 `src/main/app-service.test.ts`**（handler 业务逻辑，注入 DB，headless）

```ts
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
```

- [ ] **Step 6: 运行测试（验证失败）**

Run: `pnpm db:rebuild:node && pnpm test src/main/app-service.test.ts`
Expected: FAIL —— `@main/app-service` 不存在。

- [ ] **Step 7: 创建 `src/main/app-service.ts`**（纯逻辑，不依赖 electron/ipcMain）

```ts
import { sql } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { books } from "@main/db/schema";
import type { AppGetInfoResult, PingInput, PingResult } from "@shared/ipc";

export function ping(input: PingInput): PingResult {
  return { echo: input.msg };
}

export function getAppInfo(db: DB, version: string): AppGetInfoResult {
  const row = db
    .select({ c: sql<number>`count(*)` })
    .from(books)
    .get();
  return { version, bookCount: row?.c ?? 0 };
}
```

- [ ] **Step 8: 运行测试（验证通过）**

Run: `pnpm test src/main/app-service.test.ts`
Expected: PASS（2 断言）。

- [ ] **Step 9: 创建 `src/main/ipc/registry.ts`**（`ipcMain.handle` + 校验包装）

```ts
import { ipcMain } from "electron";
import type { z } from "zod";
import { validateInput } from "@main/ipc/validate";

/** 注册一个经 Zod 校验入参的 IPC handler。无入参时传 z.undefined()。 */
export function handle<I, O>(
  channel: string,
  inputSchema: z.ZodType<I>,
  handler: (input: I) => O | Promise<O>,
): void {
  ipcMain.handle(channel, (_event, raw: unknown) => {
    const input = validateInput(channel, inputSchema, raw);
    return handler(input);
  });
}
```

- [ ] **Step 10: 创建 `src/main/ipc/app-handlers.ts`**

```ts
import { app } from "electron";
import { z } from "zod";
import { IPC, pingInput, type AppGetInfoResult, type PingResult } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import { getAppInfo, ping } from "@main/app-service";
import { handle } from "@main/ipc/registry";

export function registerAppHandlers(): void {
  handle<{ msg: string }, PingResult>(IPC.ping, pingInput, ping);

  handle<void, AppGetInfoResult>(IPC.appGetInfo, z.undefined() as unknown as z.ZodType<void>, () =>
    getAppInfo(getDb(), app.getVersion()),
  );
}
```

- [ ] **Step 11: 更新 `src/preload.ts`**（contextBridge 暴露 `window.api`）

```ts
import { contextBridge, ipcRenderer } from "electron";
import { IPC, type AppGetInfoResult, type PingInput, type PingResult } from "@shared/ipc";

const api = {
  app: {
    getInfo: (): Promise<AppGetInfoResult> => ipcRenderer.invoke(IPC.appGetInfo),
  },
  ping: (input: PingInput): Promise<PingResult> => ipcRenderer.invoke(IPC.ping, input),
};

contextBridge.exposeInMainWorld("api", api);

export type RendererApi = typeof api;
```

- [ ] **Step 12: 在 `src/main.ts` 注册 handlers**

顶部 import 区加入：

```ts
import { registerAppHandlers } from "@main/ipc/app-handlers";
```

把 ready 回调改为：

```ts
app.on("ready", () => {
  initDb();
  registerAppHandlers();
  createWindow();
});
```

- [ ] **Step 13: 全量测试 + 类型检查 + 启动验证**

Run: `pnpm db:rebuild:node && pnpm test`
Expected: 全绿（shared schema、validate、db client、app-service）。

Run: `pnpm typecheck`
Expected: 无报错。

Run: `pnpm start`
Expected: app 正常启动（模板页），控制台无 IPC 注册报错。可在 DevTools 控制台手动验证：`await window.api.app.getInfo()` 返回 `{version:"1.0.0", bookCount:0}`、`await window.api.ping({msg:"hi"})` 返回 `{echo:"hi"}`。关闭窗口。

- [ ] **Step 14: 提交**

```bash
pnpm db:rebuild:node && pnpm test
git add -A
git commit -m "feat(ma1): Zod-validated IPC spine (app:get-info + ping) over preload bridge"
```

---

## Self-Review（计划自检）

- **Spec 覆盖**：MA1 对应 spec §3（进程边界/IPC/Zod 校验）、§4（main 侧目录结构）、§5（Drizzle 全表 + uuidv7 ID 策略）、§18（依赖/electron-rebuild）。renderer 真实 UI、阅读器、AI、Provider、工具按工作流分属 UI 原型轨与 MA2–MA4，不在本计划。
- **占位符扫描**：无 TBD/TODO；打包期迁移目录解析显式划归"打包里程碑"，dev 路径已可用且被测试覆盖。
- **类型一致性**：`IPC` 通道名与 `pingInput/pingResult/appGetInfoResult` 在 `shared/` 定义，preload/handlers/service 全程同名引用；`createDb/runMigrations/getDb/initDb` 跨 Task 3/4 一致；handler 业务逻辑（`getAppInfo`/`ping`）抽成纯函数置于 `app-service.ts`，由 vitest headless 覆盖，`registry.handle` 仅做 ipcMain 接线。
- **工作流契合**：本里程碑零真实 UI（renderer 留模板），完全 headless 可测，符合"main 侧核心先独立开发；UI 经 ui-prototype 原型确认后再移植"。
- **原生 ABI / prek**：集中在"已知约束"，涉及 start↔test 切换处统一用 `pnpm db:rebuild:node`，提交遇 hook 重排时二次 `git add`。
