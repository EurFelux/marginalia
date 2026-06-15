# Assistant 头像 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 AI assistant 加一个可上传的头像，在对话中成组显示「头像 + 名字」，可开关；头像字节进新建的通用 `blob` 表、经 `media://blob/{id}` 加载。

**Architecture:** 新建通用 `blob` 表（BLOB 原生）+ `media://blob/{blobId}` 协议；`preferences.avatarBlobId`（标准 preference）做引用、`preferences.showAgentAvatar` 做开关；上传/重置经 `agent:*` IPC（弹 dialog、写/删 blob、改 preference、GC 旧 blob）；渲染层 `AssistantAvatar` 用 `media://blob/{id}`（blobId 变即 URL 变、天然刷新），无 blobId 时回落打包的默认 svg；`MessageList` 成组首条渲染头像+`soul.name`。cover 不动（迁移见 #83）。

**Tech Stack:** Electron 41 / TypeScript 6 / Drizzle ORM 1.0-rc + better-sqlite3 / Zod 4 / React 19 / zustand / i18next / vitest 4。

设计依据：`docs/superpowers/specs/2026-06-15-assistant-avatar-design.md`。

---

## File Structure

**新建：**

- `src/main/media/blob-store.ts` — 通用 blob CRUD + `blobResponseFor`（纯函数，注入 db）
- `src/main/media/media-protocol.ts` — `media://` scheme 注册 + handler（host=`blob` → `blobResponseFor`）
- `src/main/ai/agent-avatar.ts` — 头像业务纯函数：`storeAvatar` / `resetAvatar`（注入 db；GC 旧 blob）
- `src/main/ipc/agent-handlers.ts` — `agent:pick-avatar` / `agent:reset-avatar` 胶水层（注入 dialog + fs + db）
- `src/shared/agent.ts` — `AvatarPickResult` 判别联合类型
- `src/renderer/ai/AssistantAvatar.tsx` — 圆形头像 `<img>`（media://blob 或默认 svg）
- `src/renderer/ai/default-avatar.svg` — 内置默认头像 asset
- `src/main/media/blob-store.test.ts` / `src/main/ai/agent-avatar.test.ts` — vitest

**修改：**

- `src/main/db/schema.ts` — 加 `blob` 表（+ `pnpm db:generate`）
- `src/shared/preferences.ts` — `PREFERENCE_SCHEMAS` + `setPreferenceInput` 加 `avatarBlobId` / `showAgentAvatar`
- `src/main/ipc/preferences-handlers.ts` — switch 加两 case
- `src/shared/ipc.ts` — `C` 加 `agentPickAvatar` / `agentResetAvatar`
- `src/preload-api.ts` — 加 `agent` 命名空间
- `src/renderer/store/prefs-store.ts` — state + actions
- `src/renderer/store/hydrate-preferences.ts` — 两行 hydrate
- `src/main.ts` — 注册 media scheme + handler + agent handlers
- `src/renderer/ai/MessageList.tsx` — 成组头像+名字
- `src/renderer/settings/AgentSettings.tsx` — 头像区块

---

## Task 1: 新建 `blob` 表 + 迁移

**Files:**

- Modify: `src/main/db/schema.ts`（在 `appMeta` 表定义后追加）
- Generate: `src/main/db/migrations/<timestamp>_*/`

- [ ] **Step 1: 在 schema.ts 追加 blob 表**

在 `src/main/db/schema.ts` 末尾（`readingDaily` 之后）追加：

```ts
// 通用二进制资源池（spec 2026-06-15-assistant-avatar §2.1）。本期首个使用者＝assistant 头像；
// 书封面 cover 迁入见 #83。业务表以 FK（如 preferences.avatarBlobId）引用，不再各自存 BLOB。
export const blob = sqliteTable("blob", {
  id: pkUuid(),
  data: blob_("data", { mode: "buffer" }).notNull(),
  mimeType: text("mime_type").notNull(), // 写入时 magic-byte 嗅探一次存入；读时直接用
  createdAt: nowMs(),
});
```

> 注意：drizzle 的列构造器 `blob` 与表名 `blob` 同名会遮蔽。在 schema.ts 顶部 import 处把列构造器 `blob` 重命名为 `blob_`：把 `import { blob, check, ... }` 改为 `import { blob as blob_, check, ... }`，并将文件内既有的 `blob("cover", ...)`（books 表 cover 列）改为 `blob_("cover", ...)`。

- [ ] **Step 2: 改 import 别名 + books.cover 调用**

`src/main/db/schema.ts:1-11` 的 import：将 `blob,` 改为 `blob as blob_,`。
`src/main/db/schema.ts:59`：将 `cover: blob("cover", { mode: "buffer" }),` 改为 `cover: blob_("cover", { mode: "buffer" }),`。

- [ ] **Step 3: 生成迁移**

Run: `pnpm db:generate`
Expected: 在 `src/main/db/migrations/` 新增一个子目录（含 `migration.sql` 建 `blob` 表 + `snapshot.json`）。不要手改生成物。

- [ ] **Step 4: typecheck**

Run: `pnpm typecheck`
Expected: PASS（无 `blob` 遮蔽报错）。

- [ ] **Step 5: Commit**

```bash
git add src/main/db/schema.ts src/main/db/migrations
git commit -m "feat(db): add general-purpose blob table (#82)"
```

---

## Task 2: `blob-store` 纯函数（TDD）

**Files:**

- Create: `src/main/media/blob-store.ts`
- Test: `src/main/media/blob-store.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/media/blob-store.test.ts`:

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { blob } from "@main/db/schema";
import { writeBlob, deleteBlob, blobResponseFor } from "@main/media/blob-store";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic

describe("blob-store", () => {
  it("writeBlob stores bytes + mime and returns an id", () => {
    const db = freshDb();
    const id = writeBlob(db, PNG, "image/png");
    expect(id).toMatch(/[0-9a-f-]{36}/);
    const hit = blobResponseFor(db, id);
    expect(hit).not.toBeNull();
    expect(hit!.contentType).toBe("image/png");
    expect(Array.from(hit!.bytes)).toEqual(Array.from(PNG));
  });

  it("blobResponseFor returns null for unknown id", () => {
    expect(blobResponseFor(freshDb(), "nope")).toBeNull();
  });

  it("deleteBlob removes the row", () => {
    const db = freshDb();
    const id = writeBlob(db, PNG, "image/png");
    deleteBlob(db, id);
    expect(blobResponseFor(db, id)).toBeNull();
    expect(db.select().from(blob).all()).toHaveLength(0);
  });
});
```

- [ ] **Step 2: 运行测试确认失败**

Run: `pnpm test src/main/media/blob-store.test.ts`
Expected: FAIL（`writeBlob` 等未定义 / 模块不存在）。

- [ ] **Step 3: 实现 blob-store.ts**

`src/main/media/blob-store.ts`:

```ts
import { eq } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { DB } from "@main/db/client";
import { blob } from "@main/db/schema";

/** 写入一条 blob，返回新 id。data 为原始字节，mimeType 由调用方（写入时嗅探）提供。 */
export function writeBlob(db: DB, data: Uint8Array, mimeType: string): string {
  const id = uuidv7();
  db.insert(blob)
    .values({ id, data: Buffer.from(data), mimeType, createdAt: Date.now() })
    .run();
  return id;
}

/** 删除一条 blob（缺失无害）。 */
export function deleteBlob(db: DB, id: string): void {
  db.delete(blob).where(eq(blob.id, id)).run();
}

/** 读一条 blob 的字节 + content-type（media:// 协议 handler 用）。无此 id → null。 */
export function blobResponseFor(
  db: DB,
  id: string,
): { bytes: Uint8Array; contentType: string } | null {
  const row = db
    .select({ data: blob.data, mimeType: blob.mimeType })
    .from(blob)
    .where(eq(blob.id, id))
    .get();
  if (!row?.data) return null;
  return { bytes: new Uint8Array(row.data), contentType: row.mimeType };
}
```

- [ ] **Step 4: 运行测试确认通过**

Run: `pnpm test src/main/media/blob-store.test.ts`
Expected: PASS（3 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/main/media/blob-store.ts src/main/media/blob-store.test.ts
git commit -m "feat(media): add blob-store CRUD over the blob table (#82)"
```

---

## Task 3: `media://blob` 协议 + main.ts 注册

**Files:**

- Create: `src/main/media/media-protocol.ts`
- Modify: `src/main.ts`

- [ ] **Step 1: 实现 media-protocol.ts**

`src/main/media/media-protocol.ts`（仿 `cover-protocol.ts`）：

```ts
import { protocol } from "electron";
import { getDb } from "@main/db/instance";
import { blobResponseFor } from "@main/media/blob-store";

/** 注册 media:// 为 privileged/secure scheme。必须在 app.ready 之前调用（main.ts 顶层）。 */
export function registerMediaProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    { scheme: "media", privileges: { standard: true, secure: true, supportFetchAPI: true } },
  ]);
}

/**
 * 挂 media:// handler。本期路由：
 *   media://blob/<blobId> → blob 表字节
 * 未知 host / 缺失 → 404。必须在 app.ready 内、initDb() 之后调用（handler 取 getDb()）。
 */
export function registerMediaProtocol(): void {
  protocol.handle("media", (request) => {
    const url = new URL(request.url);
    if (url.host !== "blob") return new Response(null, { status: 404 });
    const id = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    const hit = blobResponseFor(getDb(), id);
    if (!hit) return new Response(null, { status: 404 });
    return new Response(new Uint8Array(hit.bytes), {
      headers: { "content-type": hit.contentType },
    });
  });
}
```

- [ ] **Step 2: 在 main.ts 注册 scheme（app.ready 前）**

`src/main.ts`：

- import 处（第 24 行 `registerCoverProtocol` import 之后）加：
  ```ts
  import { registerMediaProtocol, registerMediaProtocolScheme } from "@main/media/media-protocol";
  ```
- 第 65 行 `registerCoverProtocolScheme();` 之后加：

  ```ts
  registerMediaProtocolScheme(); // media:// scheme 注册须在 app.ready 前
  ```

- [ ] **Step 3: 在 main.ts 注册 handler（initDb 后）**

`src/main.ts` 第 146 行 `registerCoverProtocol();` 之后加：

```ts
registerMediaProtocol(); // media:// handler 需 getDb()，故在 initDb 后
```

- [ ] **Step 4: typecheck**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/main/media/media-protocol.ts src/main.ts
git commit -m "feat(media): register media://blob protocol (#82)"
```

---

## Task 4: 注册 `avatarBlobId` + `showAgentAvatar` preference（TDD）

**Files:**

- Modify: `src/shared/preferences.ts`
- Modify: `src/main/ipc/preferences-handlers.ts`
- Test: `src/main/preferences/repository.test.ts`（追加用例）

- [ ] **Step 1: 追加失败测试**

在 `src/main/preferences/repository.test.ts` 的 `describe` 内追加：

```ts
it("round-trips avatarBlobId (nullable) and showAgentAvatar", () => {
  const db = freshDb();
  setPreference(db, "showAgentAvatar", false);
  expect(getPreference(db, "showAgentAvatar")).toBe(false);
  setPreference(db, "avatarBlobId", "blob-123");
  expect(getPreference(db, "avatarBlobId")).toBe("blob-123");
  setPreference(db, "avatarBlobId", null);
  expect(getPreference(db, "avatarBlobId")).toBeNull();
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test src/main/preferences/repository.test.ts`
Expected: FAIL（`avatarBlobId` / `showAgentAvatar` 不是合法 key，typecheck/运行时报错）。

- [ ] **Step 3: 在 preferences.ts 注册两个 key**

`src/shared/preferences.ts`：

- `PREFERENCE_SCHEMAS`（第 82-98 块）在 `instructions: z.string(),` 后加：
  ```ts
  showAgentAvatar: z.boolean(),
  avatarBlobId: z.string().nullable(),
  ```
- `setPreferenceInput`（第 115-131 块）在 `z.object({ key: z.literal("instructions"), value: z.string() }),` 后加：

  ```ts
  z.object({ key: z.literal("showAgentAvatar"), value: z.boolean() }),
  z.object({ key: z.literal("avatarBlobId"), value: z.string().nullable() }),
  ```

- [ ] **Step 4: 在 preferences-handlers.ts 补 switch case**

`src/main/ipc/preferences-handlers.ts`，在 `case "ttsPrefs":`（第 49-50 行）之后、`default:` 之前加：

```ts
      case "showAgentAvatar":
        return setPreference(getDb(), input.key, input.value);
      case "avatarBlobId":
        return setPreference(getDb(), input.key, input.value);
```

- [ ] **Step 5: 运行确认通过**

Run: `pnpm test src/main/preferences/repository.test.ts`
Expected: PASS（含新用例）。

- [ ] **Step 6: typecheck（验穷尽性守卫满足）**

Run: `pnpm typecheck`
Expected: PASS（`preferences-handlers` 的 `_exhaustive: never` 不报错）。

- [ ] **Step 7: Commit**

```bash
git add src/shared/preferences.ts src/main/ipc/preferences-handlers.ts src/main/preferences/repository.test.ts
git commit -m "feat(prefs): register showAgentAvatar + avatarBlobId preferences (#82)"
```

---

## Task 5: 头像业务纯函数 `agent-avatar`（TDD）

**Files:**

- Create: `src/main/ai/agent-avatar.ts`
- Test: `src/main/ai/agent-avatar.test.ts`

设计：`storeAvatar` 接收已读出的字节（dialog/fs 在胶水层做），做类型/大小校验 → 写 blob → 切换 `avatarBlobId` → 删旧 blob（GC）。`resetAvatar` 删当前 blob + 置 `avatarBlobId=null`。

- [ ] **Step 1: 写失败测试**

`src/main/ai/agent-avatar.test.ts`:

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { blob } from "@main/db/schema";
import { getPreference } from "@main/preferences/repository";
import { storeAvatar, resetAvatar, AVATAR_MAX_BYTES } from "@main/ai/agent-avatar";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TXT = new Uint8Array([0x68, 0x69]); // "hi" — not an image

describe("agent-avatar", () => {
  it("storeAvatar writes a blob, sets avatarBlobId, returns set+id", () => {
    const db = freshDb();
    const r = storeAvatar(db, PNG);
    expect(r.status).toBe("set");
    const id = r.status === "set" ? r.blobId : "";
    expect(getPreference(db, "avatarBlobId")).toBe(id);
    expect(db.select().from(blob).all()).toHaveLength(1);
  });

  it("rejects oversize bytes (too-large), no write", () => {
    const db = freshDb();
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1);
    big.set(PNG, 0);
    expect(storeAvatar(db, big).status).toBe("too-large");
    expect(getPreference(db, "avatarBlobId")).toBeNull();
    expect(db.select().from(blob).all()).toHaveLength(0);
  });

  it("rejects non-image bytes (unsupported), no write", () => {
    const db = freshDb();
    expect(storeAvatar(db, TXT).status).toBe("unsupported");
    expect(db.select().from(blob).all()).toHaveLength(0);
  });

  it("replacing deletes the old blob (no orphan)", () => {
    const db = freshDb();
    const r1 = storeAvatar(db, PNG);
    const r2 = storeAvatar(db, PNG);
    const id2 = r2.status === "set" ? r2.blobId : "";
    const rows = db.select().from(blob).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id2);
    expect(getPreference(db, "avatarBlobId")).toBe(id2);
    void r1;
  });

  it("resetAvatar deletes blob and nulls the preference", () => {
    const db = freshDb();
    storeAvatar(db, PNG);
    resetAvatar(db);
    expect(getPreference(db, "avatarBlobId")).toBeNull();
    expect(db.select().from(blob).all()).toHaveLength(0);
  });

  it("resetAvatar is a no-op when nothing set", () => {
    const db = freshDb();
    expect(() => resetAvatar(db)).not.toThrow();
  });
});
```

- [ ] **Step 2: 运行确认失败**

Run: `pnpm test src/main/ai/agent-avatar.test.ts`
Expected: FAIL（模块/导出不存在）。

- [ ] **Step 3: 实现 agent-avatar.ts**

`src/main/ai/agent-avatar.ts`:

```ts
import type { DB } from "@main/db/client";
import type { AvatarPickResult } from "@shared/agent";
import { sniffImageType } from "@main/library/cover-bytes";
import { writeBlob, deleteBlob } from "@main/media/blob-store";
import { getPreference, setPreference } from "@main/preferences/repository";

/** 头像上传大小上限：2 MB（spec §5）。 */
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024;
const ALLOWED = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

/** 校验并存头像字节：写新 blob → 切 avatarBlobId → 删旧 blob（GC）。返回判别结果。 */
export function storeAvatar(db: DB, bytes: Uint8Array): AvatarPickResult {
  if (bytes.byteLength > AVATAR_MAX_BYTES) return { status: "too-large" };
  const mime = sniffImageType(bytes);
  if (!ALLOWED.has(mime)) return { status: "unsupported" };
  const prev = getPreference(db, "avatarBlobId");
  const blobId = writeBlob(db, bytes, mime);
  setPreference(db, "avatarBlobId", blobId);
  if (prev) deleteBlob(db, prev);
  return { status: "set", blobId };
}

/** 重置为默认：删当前头像 blob + 置 avatarBlobId=null。无头像时无害。 */
export function resetAvatar(db: DB): void {
  const prev = getPreference(db, "avatarBlobId");
  setPreference(db, "avatarBlobId", null);
  if (prev) deleteBlob(db, prev);
}
```

> 依赖 Task 6 的 `src/shared/agent.ts`（`AvatarPickResult`）。若先做本任务，先建该文件（见 Task 6 Step 1），否则 import 报错。

- [ ] **Step 4: 运行确认通过**

Run: `pnpm test src/main/ai/agent-avatar.test.ts`
Expected: PASS（6 passed）。

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/agent-avatar.ts src/main/ai/agent-avatar.test.ts src/shared/agent.ts
git commit -m "feat(ai): add avatar store/reset business logic with blob GC (#82)"
```

---

## Task 6: agent IPC 契约 + handlers + preload

**Files:**

- Create: `src/shared/agent.ts`
- Modify: `src/shared/ipc.ts`
- Create: `src/main/ipc/agent-handlers.ts`
- Modify: `src/main.ts`
- Modify: `src/preload-api.ts`

- [ ] **Step 1: 定义结果类型 shared/agent.ts**

`src/shared/agent.ts`:

```ts
/** agent:pick-avatar 结果（判别联合）：成功带新 blobId；其余为分支原因（渲染层据此 toast）。 */
export type AvatarPickResult =
  | { status: "set"; blobId: string }
  | { status: "cancelled" }
  | { status: "too-large" }
  | { status: "unsupported" };
```

- [ ] **Step 2: 在 ipc.ts 加契约**

`src/shared/ipc.ts`：

- import 区加：`import type { AvatarPickResult } from "@shared/agent";`
- `C` 对象内（`preferences` 段之后）加：

  ```ts
  // agent（头像）
  agentPickAvatar: def("agent:pick-avatar", "invoke", z.void(), out<AvatarPickResult>()),
  agentResetAvatar: def("agent:reset-avatar", "invoke", z.void(), out<void>()),
  ```

- [ ] **Step 3: 实现 agent-handlers.ts**

`src/main/ipc/agent-handlers.ts`（仿 library-handlers 的 dialog + bind）：

```ts
import { readFile } from "node:fs/promises";
import { BrowserWindow, dialog } from "electron";
import { C } from "@shared/ipc";
import type { AvatarPickResult } from "@shared/agent";
import { getDb } from "@main/db/instance";
import { storeAvatar, resetAvatar } from "@main/ai/agent-avatar";
import { bind, register, type Binding } from "@main/ipc/registry";
import { createLogger } from "@main/logger";

const log = createLogger("agent");

export const agentBindings: Binding[] = [
  bind(C.agentPickAvatar, async (): Promise<AvatarPickResult> => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      properties: ["openFile" as const],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || r.filePaths.length === 0) return { status: "cancelled" };
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(r.filePaths[0]));
    } catch (err) {
      log.warn("read avatar file failed", err);
      return { status: "unsupported" };
    }
    return storeAvatar(getDb(), bytes);
  }),

  bind(C.agentResetAvatar, () => resetAvatar(getDb())),
];

export function registerAgentHandlers(): void {
  register(agentBindings);
}
```

- [ ] **Step 4: 在 main.ts 注册 handler**

`src/main.ts`：

- import 区加：`import { registerAgentHandlers } from "@main/ipc/agent-handlers";`
- `registerPreferenceHandlers();`（第 153 行）之后加：`registerAgentHandlers();`

- [ ] **Step 5: 在 preload-api.ts 暴露 agent**

`src/preload-api.ts`，在 `memories: {...}` 段之后（第 146 行 `}` 之前）加：

```ts
    agent: {
      /** 选本地图片设为头像（主进程弹 dialog）；取消/超大/类型不符返回对应判别状态。 */
      pickAvatar: inv(C.agentPickAvatar),
      resetAvatar: inv(C.agentResetAvatar),
    },
```

- [ ] **Step 6: typecheck**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 7: Commit**

```bash
git add src/shared/agent.ts src/shared/ipc.ts src/main/ipc/agent-handlers.ts src/main.ts src/preload-api.ts
git commit -m "feat(ipc): add agent:pick-avatar / reset-avatar channels (#82)"
```

---

## Task 7: prefs-store + hydrate（avatarBlobId + showAgentAvatar）

**Files:**

- Modify: `src/renderer/store/prefs-store.ts`
- Modify: `src/renderer/store/hydrate-preferences.ts`

说明：`showAgentAvatar` 是用户开关 → `set*` 走 `persistPreference`。`avatarBlobId` 由主进程 agent IPC 落盘 → 渲染层用 `setAvatarBlobId` **只 setState 镜像、不回写**（避免双写）。

- [ ] **Step 1: prefs-store 加 state**

`src/renderer/store/prefs-store.ts`：

- `interface PrefsState` 内（`ttsPrefs` 之后）加：
  ```ts
  /** 对话中显示头像总开关（默认开）。 */
  showAgentAvatar: boolean;
  /** 当前头像 blob 引用；null = 用默认头像。由主进程 agent IPC 落盘，渲染层只镜像。 */
  avatarBlobId: string | null;
  ```
- `interface PrefsActions` 内（`updateTtsPrefs` 之后）加：
  ```ts
  setShowAgentAvatar: (v: boolean) => void;
  setAvatarBlobId: (v: string | null) => void;
  ```
- `PREFS_INITIAL` 内（`ttsPrefs` 之后）加：
  ```ts
  showAgentAvatar: true,
  avatarBlobId: null,
  ```
- store 实现内（`updateTtsPrefs` 之后）加：

  ```ts
  setShowAgentAvatar: (showAgentAvatar) => {
    persistPreference({ key: "showAgentAvatar", value: showAgentAvatar });
    set({ showAgentAvatar });
  },
  setAvatarBlobId: (avatarBlobId) => set({ avatarBlobId }),
  ```

- [ ] **Step 2: hydrate 两个 key**

`src/renderer/store/hydrate-preferences.ts`，在 `if (snap.ttsPrefs) ...`（第 32 行）之后加：

```ts
if (snap.showAgentAvatar !== undefined) {
  usePrefsStore.setState({ showAgentAvatar: snap.showAgentAvatar });
}
if (snap.avatarBlobId !== undefined) {
  usePrefsStore.setState({ avatarBlobId: snap.avatarBlobId });
}
```

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/store/prefs-store.ts src/renderer/store/hydrate-preferences.ts
git commit -m "feat(store): mirror showAgentAvatar + avatarBlobId in prefs-store (#82)"
```

---

## Task 8: 默认头像 asset + `AssistantAvatar` 组件

**Files:**

- Create: `src/renderer/ai/default-avatar.svg`
- Create: `src/renderer/ai/AssistantAvatar.tsx`

- [ ] **Step 1: 内置默认头像 svg**

`src/renderer/ai/default-avatar.svg`（简洁占位，美术可后续替换，spec §9）：

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="64" height="64">
  <defs>
    <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#f6c177"/>
      <stop offset="1" stop-color="#eb6f92"/>
    </linearGradient>
  </defs>
  <rect width="64" height="64" rx="32" fill="url(#g)"/>
  <circle cx="24" cy="28" r="3.2" fill="#fff"/>
  <circle cx="40" cy="28" r="3.2" fill="#fff"/>
  <path d="M22 38c4 5 16 5 20 0" stroke="#fff" stroke-width="3" stroke-linecap="round" fill="none"/>
</svg>
```

- [ ] **Step 2: 实现 AssistantAvatar.tsx**

`src/renderer/ai/AssistantAvatar.tsx`:

```tsx
import { usePrefsStore } from "@renderer/store/prefs-store";
import { cn } from "@renderer/lib/utils";
import defaultAvatarUrl from "@renderer/ai/default-avatar.svg";

/**
 * Assistant 头像：有 avatarBlobId 走 media://blob/{id}（id 变即 URL 变、天然刷新），
 * 否则用内置默认 svg。圆形；尺寸由 className 控制（对话内小、设置预览大）。
 */
export function AssistantAvatar({ className }: { className?: string }) {
  const blobId = usePrefsStore((s) => s.avatarBlobId);
  const src = blobId ? `media://blob/${encodeURIComponent(blobId)}` : defaultAvatarUrl;
  return (
    <img
      src={src}
      alt=""
      className={cn("shrink-0 rounded-full object-cover", className)}
      onError={(e) => {
        // 协议异常兜底：回落默认 svg（避免破图）。
        if (e.currentTarget.src !== defaultAvatarUrl) e.currentTarget.src = defaultAvatarUrl;
      }}
    />
  );
}
```

> 若 `import ... from "...svg"` 类型报错：项目渲染层走 Vite，`*.svg` 默认按 url 解析。如缺类型声明，在 `src/renderer/` 的环境声明（如 `vite-env.d.ts`，无则建）补 `declare module "*.svg" { const url: string; export default url; }`。先 typecheck，按需补。

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: PASS（如失败按 Step 2 备注补 svg 模块声明后再跑）。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/ai/default-avatar.svg src/renderer/ai/AssistantAvatar.tsx src/renderer/vite-env.d.ts
git commit -m "feat(ai): add AssistantAvatar component + default avatar asset (#82)"
```

（若未新建 `vite-env.d.ts` 则不要 add 它。）

---

## Task 9: `MessageList` 成组渲染头像 + 名字

**Files:**

- Modify: `src/renderer/ai/MessageList.tsx`

目标：开关 `showAgentAvatar` 开启时，**成组首条** assistant 消息渲染「头像 + `soul.name`」，气泡缩进对齐；同组后续消息留头像列空白、缩进对齐；开关关闭时完全回到现状。

- [ ] **Step 1: 在 map 计算成组首条 + 传参**

`src/renderer/ai/MessageList.tsx`：

- 顶部 import 加：
  ```tsx
  import { usePrefsStore } from "@renderer/store/prefs-store";
  import { AssistantAvatar } from "@renderer/ai/AssistantAvatar";
  ```
- `MessageList` 函数体内（`const lastId = ...` 之前）加：
  ```tsx
  const showAvatar = usePrefsStore((s) => s.showAgentAvatar);
  const agentName = usePrefsStore((s) => s.soul.name);
  ```
- 把 `messages.map((m) => ...)` 改为带 index、计算成组首条，并把 `showAvatar`/`agentName`/`groupHead` 传入 `AssistantBubble`：

  ```tsx
  {
    messages.map((m, i) =>
      m.role === "user" ? (
        <UserBubble key={m.id} m={m} />
      ) : (
        <AssistantBubble
          key={m.id}
          m={m}
          streaming={status === "streaming" && m.id === lastId}
          chapters={chapters}
          showAvatar={showAvatar}
          agentName={agentName}
          groupHead={i === 0 || messages[i - 1].role !== "assistant"}
        />
      ),
    );
  }
  ```

- [ ] **Step 2: 改 AssistantBubble 渲染头像列 + 名字**

把 `AssistantBubble` 函数（第 136-164 行）整体替换为：

```tsx
function AssistantBubble({
  m,
  streaming,
  chapters,
  showAvatar,
  agentName,
  groupHead,
}: {
  m: ChatUIMessage;
  streaming: boolean;
  chapters: ChapterRefDto[];
  showAvatar: boolean;
  agentName: string;
  groupHead: boolean;
}) {
  const segs = segments(m.parts);
  const hasText = segs.some((s) => s.kind === "text");
  if (segs.length === 0 && !streaming) return null;

  const bubble = (
    <div className="group flex flex-col items-start">
      {showAvatar && groupHead && (
        <span className="mb-1 text-xs font-medium text-muted-foreground">{agentName}</span>
      )}
      <div className="max-w-full space-y-2 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground">
        {segs.map((s, i) =>
          s.kind === "text" ? (
            <LocalizedStreamdown key={i}>{s.text}</LocalizedStreamdown>
          ) : (
            <ToolStepRow key={i} part={s.part} chapters={chapters} />
          ),
        )}
        {streaming && !hasText && <ThinkingCursor />}
      </div>
      {!streaming && <MessageToolbar m={m} />}
    </div>
  );

  if (!showAvatar) {
    // 开关关闭：回到原布局（气泡自身限宽 88%）。
    return <div className="max-w-[88%]">{bubble}</div>;
  }
  // 开关开启：头像列（首条显头像、后续留白）+ 内容列（缩进对齐）。
  return (
    <div className="flex max-w-[92%] items-start gap-2">
      <div className="w-7 shrink-0">{groupHead && <AssistantAvatar className="size-7" />}</div>
      <div className="min-w-0 flex-1">{bubble}</div>
    </div>
  );
}
```

> 说明：原 `AssistantBubble` 气泡用 `max-w-[88%]`；开关开启时改由外层列容器限宽（`max-w-[92%]`）、气泡内层用 `max-w-full`，避免双重限宽把气泡压窄。`PendingBubble` 维持原样（submitted 空窗占位，无需头像）。

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/ai/MessageList.tsx
git commit -m "feat(ai): show grouped avatar + name on assistant messages (#82)"
```

---

## Task 10: `AgentSettings` 头像区块 + i18n

**Files:**

- Modify: `src/renderer/settings/AgentSettings.tsx`

- [ ] **Step 1: 加头像区块**

`src/renderer/settings/AgentSettings.tsx`：

- 顶部 import 加：
  ```tsx
  import { toast } from "sonner";
  import { usePrefsStore } from "@renderer/store/prefs-store";
  import { AssistantAvatar } from "@renderer/ai/AssistantAvatar";
  import { Button } from "@renderer/components/ui/button";
  import { Checkbox } from "@renderer/components/ui/checkbox";
  ```
  （`usePrefsStore` 已 import，勿重复。）
- `AgentSettings` 函数体内（现有 `setInstructions` 之后）加：

  ```tsx
  const showAgentAvatar = usePrefsStore((s) => s.showAgentAvatar);
  const setShowAgentAvatar = usePrefsStore((s) => s.setShowAgentAvatar);
  const setAvatarBlobId = usePrefsStore((s) => s.setAvatarBlobId);

  const onPickAvatar = async () => {
    const r = await window.api.agent.pickAvatar();
    if (r.status === "set") setAvatarBlobId(r.blobId);
    else if (r.status === "too-large")
      toast.error(t("settings.agent.avatarTooLarge", "图片太大，请选择 2 MB 以内的图片"));
    else if (r.status === "unsupported")
      toast.error(t("settings.agent.avatarUnsupported", "不支持的图片格式"));
  };

  const onResetAvatar = async () => {
    await window.api.agent.resetAvatar();
    setAvatarBlobId(null);
  };
  ```

- 在 `<section>` 内、名字 block（`{/* 名字 */}`）**之前**插入头像 block：
  ```tsx
  {
    /* 头像 */
  }
  <div className="space-y-1.5">
    <span className="block text-sm font-medium">{t("settings.agent.avatar", "头像")}</span>
    <p className="text-[11px] leading-relaxed text-muted-foreground">
      {t("settings.agent.avatarDesc", "显示在对话中的 AI 头像。支持 png/jpg/webp/gif，2 MB 以内。")}
    </p>
    <div className="flex items-center gap-3">
      <AssistantAvatar className="size-14" />
      <div className="flex gap-2">
        <Button variant="outline" size="sm" onClick={onPickAvatar}>
          {t("settings.agent.avatarUpload", "上传头像")}
        </Button>
        <Button variant="ghost" size="sm" onClick={onResetAvatar}>
          {t("settings.agent.avatarReset", "恢复默认")}
        </Button>
      </div>
    </div>
    <label className="mt-1 flex items-center gap-2 text-sm">
      <Checkbox checked={showAgentAvatar} onCheckedChange={(v) => setShowAgentAvatar(v === true)} />
      {t("settings.agent.avatarShowInChat", "在对话中显示头像")}
    </label>
  </div>;
  ```

> `Button` / `Checkbox` 路径以仓库现有为准：参考 `ReadingSettings.tsx` 里 `Checkbox` 的 import 与 `onCheckedChange` 用法（Base UI），保持一致。若组件 prop 形状不同，按既有用法对齐。

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: PASS。

- [ ] **Step 3: 抽取 i18n key**

Run: `pnpm i18n:extract`
Expected: 新 key（`settings.agent.avatar*`）写入 locale；其后 `pnpm i18n:lint` 无缺漏（参考 memory `i18n-operational-gotchas`，必要时 grep 校验）。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/settings/AgentSettings.tsx src/shared/i18n/locales
git commit -m "feat(settings): add avatar upload/reset + show toggle in agent settings (#82)"
```

---

## Task 11: 全量校验 + 冒烟

**Files:** 无（验证关）

- [ ] **Step 1: 类型 + lint + 格式**

Run: `pnpm typecheck && pnpm lint && pnpm format:check`
Expected: 全 PASS（format 若 fail 跑 `pnpm format` 修，注意 memory `oxfmt-regex-unicode-mangling`：改动含特殊字符的文件后逐字符核验）。

- [ ] **Step 2: 全量测试**

Run: `pnpm test`
Expected: 全 PASS（含 blob-store / agent-avatar / preferences 新用例）。

- [ ] **Step 3: i18n 校验**

Run: `pnpm i18n:lint`
Expected: 无缺漏 key。

- [ ] **Step 4: 真机冒烟（手动，pnpm start）**

启动 `pnpm start`，验证（memory `importbook-writefile-two-step` 精神：真开书走流程）：

1. 设置 → 助手：默认头像显示；点「上传头像」选张 png → 头像即时更新。
2. 开一本书、开 AI 面板提问 → assistant 回复左侧显示头像 + 名字（Lia）；连续多条回复只首条显示头像。
3. 关闭「在对话中显示头像」开关 → 对话回到无头像原样。
4. 「恢复默认」→ 回落默认 svg。
5. 改 SOUL 名字 → 对话内名字随之更新。
6. **cover 回归**：书库网格封面正常显示（media:// 引入不应影响 cover://）。

- [ ] **Step 5: 记录冒烟结果**

把冒烟结论（通过/异常）写入 commit 或 PR 描述；如有异常回到对应 Task 修复。

---

## Task 12: 开 PR

- [ ] **Step 1: push 分支**

```bash
git push -u origin worktree-async-percolating-orbit
```

- [ ] **Step 2: changeset（用户向 changelog）**

Run: `pnpm changeset`（写一条英文用户向条目，如 "Add a customizable assistant avatar shown in conversation"）；commit changeset 文件。

- [ ] **Step 3: 建 PR**

```bash
gh pr create --repo EurFelux/marginalia --base main \
  --title "feat: assistant avatar in conversation (#82)" \
  --body "$(cat <<'BODY'
Implements #82: customizable assistant avatar shown in conversation (toggleable).

- New general-purpose `blob` table; avatar bytes stored BLOB-native, referenced by `preferences.avatarBlobId`.
- New `media://blob/{id}` protocol (cover stays on `cover://`; migration tracked in #83).
- Grouped avatar + `soul.name` on assistant messages; `showAgentAvatar` toggle (default on).
- Upload/reset in Settings → Agent.

Spec: docs/superpowers/specs/2026-06-15-assistant-avatar-design.md

🤖 Generated with [Claude Code](https://claude.com/claude-code)
BODY
)"
```

- [ ] **Step 4: kanban**

PR 合并后 #82 自动挪 Done（memory `kanban-auto-done-on-merge`）；开 PR 后手动把 #82 挪到 In review（kanban skill 列 option `df73e18b`）。

---

## Self-Review 结果

- **Spec 覆盖**：§2.1 blob 表→T1/T2；§2.2 avatarBlobId→T4/T7；§2.3 showAgentAvatar→T4/T7；§2.4 名字→T9；§3.1 media 协议→T3；§3.2 blobResponseFor→T2；§3.3 IPC→T5/T6；§3.4 默认 asset→T8；§4.1 AssistantAvatar→T8；§4.2 MessageList→T9；§4.3 AgentSettings→T10；§5 边界/GC→T5（too-large/unsupported/孤儿）+T10（toast）；§6 测试→T2/T4/T5；§7 回归→T11 冒烟（cover）。无遗漏。
- **类型一致**：`AvatarPickResult`（shared/agent.ts）贯穿 agent-avatar / ipc / handlers / AgentSettings；`storeAvatar`/`resetAvatar`/`writeBlob`/`deleteBlob`/`blobResponseFor` 跨任务签名一致；preference key `avatarBlobId`/`showAgentAvatar` 全程一致。
- **占位符**：无 TBD；默认头像给了具体 svg；i18n 用内联默认中文 + extract。
- **已知顺序依赖**：Task 5 import `@shared/agent`（Task 6 Step 1 创建）——已在 Task 5 备注「先建该文件」。
