# Data Backup & Restore Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add manual zip export / replace-all restore of all user data (SQLite DB + `books/`), gated by a version-compat check and protected by a pre-restore safety copy + app relaunch.

**Architecture:** Thick main / pure core. `src/shared/backup.ts` is the Zod single source (manifest + IPC contracts). Pure, headless-testable core (`buildManifest`, `checkRestoreCompatibility`, archive/restore fs helpers). Thin glue (`backup-handlers.ts`) owns dialogs, `db.$client.backup()`, and `app.relaunch()`. Export = online `.backup()` snapshot + `archiver` zip; restore = `yauzl` extract to staging → integrity/compat check → move current data to `pre-restore/<ts>/` → swap → relaunch.

**Tech Stack:** Electron 41, better-sqlite3 (`$client.backup()`), Drizzle, Zod 4, `archiver` (zip write), `yauzl` (zip read), vitest 4.

Spec: `docs/superpowers/specs/2026-06-09-backup-restore-design.md`. Issue: #28.

---

## File Structure

- Create `src/shared/backup.ts` — manifest Zod schema + types, restore input schema, `BackupInspection`/`BackupExportResult` types.
- Modify `src/shared/ipc.ts` — add `backupExport` / `backupInspect` / `backupRestore` contracts.
- Create `src/main/db/migrations-path.ts` — `resolveMigrationsFolder()` (electron-coupled) + pure `listMigrationDirs(folder)` / `latestMigrationDir(folder)`.
- Modify `src/main/db/instance.ts` — use `resolveMigrationsFolder()`; add `closeDb()`.
- Modify `src/main/app/app-service.ts` — add `tmpDir` + `preRestoreDir` path keys.
- Create `src/main/backup/manifest.ts` — pure `buildManifest(db, opts)`.
- Create `src/main/backup/compat.ts` — pure `checkRestoreCompatibility(bundleSchemaHead, knownMigrationDirs)`.
- Create `src/main/backup/archive.ts` — `sha256File`, `createBackupZip`, `readZipEntryText`, `extractZip`.
- Create `src/main/backup/restore.ts` — `verifyBookFiles`, `applyRestore`.
- Create `src/main/backup/backup-service.ts` — `exportBackup`, `inspectBackup`, `restoreBackup` orchestration.
- Create `src/main/ipc/backup-handlers.ts` — `backupBindings` + `registerBackupHandlers()`.
- Modify `src/main.ts` — call `registerBackupHandlers()`.
- Modify `src/preload-api.ts` — add `backup` group.
- Modify `src/main/ipc/bindings-coverage.test.ts` — include `backupBindings`.
- Modify `src/renderer/settings/AdvancedSettings.tsx` — backup/restore UI + restore confirm dialog.
- Add i18n keys (via `pnpm i18n:extract`).
- Add changeset.

---

## Task 1: Add zip dependencies

**Files:**

- Modify: `package.json`, `pnpm-lock.yaml`

- [ ] **Step 1: Install runtime + type deps**

Run:

```bash
pnpm add archiver yauzl
pnpm add -D @types/archiver @types/yauzl
```

`archiver` and `yauzl` are pure-JS (no native build), so no `pnpm-workspace.yaml` `allowBuilds` entry is needed.

- [ ] **Step 2: Confirm better-sqlite3 ABI survived install**

`pnpm add` reinstalls and rebuilds better-sqlite3 to the system-Node ABI; the root `postinstall` (`pnpm db:rebuild:electron`) should have flipped it back to Electron ABI. Verify by running an existing DB test:

Run: `pnpm test src/main/db/client.test.ts`
Expected: PASS. If it fails with a `NODE_MODULE_VERSION` mismatch, run `pnpm db:rebuild:electron` then re-run.

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS (no usages yet; just confirms types resolve).

- [ ] **Step 4: Commit**

```bash
git add package.json pnpm-lock.yaml
git commit -m "build(backup): add archiver + yauzl for zip bundling"
```

---

## Task 2: AppService path keys (`tmpDir`, `preRestoreDir`)

**Files:**

- Modify: `src/main/app/app-service.ts:22` (DataPathKey), `:25-29` (DATA_PATHS)
- Test: `src/main/app/app-service.test.ts` (if it enumerates keys)

- [ ] **Step 1: Add the two keys**

In `src/main/app/app-service.ts`, extend the type and map:

```typescript
export type DataPathKey = "logsDir" | "booksDir" | "dbFile" | "tmpDir" | "preRestoreDir";

const DATA_PATHS: Record<DataPathKey, string> = {
  logsDir: "logs",
  booksDir: "books",
  dbFile: "marginalia.db", // 历史布局：db 三件套在 dataDir 根（改动布局需数据迁移）
  tmpDir: "tmp", // 备份导出/还原的同盘暂存区（rename 不跨设备）
  preRestoreDir: "pre-restore", // 还原前的当前数据安全副本父目录（pre-restore/<ts>/）
};
```

- [ ] **Step 2: Typecheck + run AppService test**

Run: `pnpm typecheck && pnpm test src/main/app/app-service.test.ts`
Expected: PASS. If the test asserts the full `DATA_PATHS` shape and now fails, add `tmpDir`/`preRestoreDir` expectations to it matching the strings above.

- [ ] **Step 3: Commit**

```bash
git add src/main/app/app-service.ts src/main/app/app-service.test.ts
git commit -m "feat(backup): add tmpDir + preRestoreDir app-service path keys"
```

---

## Task 3: migrations-path helper + instance.ts (`closeDb`, shared resolver)

**Files:**

- Create: `src/main/db/migrations-path.ts`
- Test: `src/main/db/migrations-path.test.ts`
- Modify: `src/main/db/instance.ts`

- [ ] **Step 1: Write the failing test**

`src/main/db/migrations-path.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/db/migrations-path.test.ts`
Expected: FAIL ("Cannot find module @main/db/migrations-path").

- [ ] **Step 3: Implement `migrations-path.ts`**

```typescript
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";

/** dev/prod 迁移目录解析（与历史 instance.ts 逻辑一致）。碰 Electron 全局，不在纯核心测试中调用。 */
export function resolveMigrationsFolder(): string {
  const devUrl =
    typeof MAIN_WINDOW_VITE_DEV_SERVER_URL !== "undefined"
      ? MAIN_WINDOW_VITE_DEV_SERVER_URL
      : undefined;
  return devUrl
    ? path.resolve(process.cwd(), "src/main/db/migrations")
    : path.join(process.resourcesPath, "migrations");
}

/** 列出迁移子目录名（字典序；目录格式 <timestamp>_<name>）。纯函数（注入 folder）。 */
export function listMigrationDirs(folder: string): string[] {
  if (!existsSync(folder)) return [];
  return readdirSync(folder, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => e.name)
    .sort();
}

/** 最新迁移目录名（字典序末位）；无迁移时空串。纯函数。 */
export function latestMigrationDir(folder: string): string {
  const dirs = listMigrationDirs(folder);
  return dirs.length ? dirs[dirs.length - 1] : "";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/db/migrations-path.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Refactor instance.ts to reuse resolver + add `closeDb`**

In `src/main/db/instance.ts`, replace the inline `migrationsFolder` computation and add `closeDb`. Final file:

```typescript
import { appService } from "@main/app";
import { createDb, runMigrations, type DB } from "@main/db/client";
import { resolveMigrationsFolder } from "@main/db/migrations-path";
import { ensureBuiltinProviders } from "@main/providers/default-providers";
import { createLogger } from "@main/logger";

const log = createLogger("db");

let db: DB | undefined;

export function initDb(): DB {
  if (db) return db;
  const dbPath = appService.getPath("dbFile");
  const candidate = createDb(dbPath);
  log.info("running db migrations");
  runMigrations(candidate, resolveMigrationsFolder());
  log.info("db ready");
  ensureBuiltinProviders(candidate);
  db = candidate;
  return db;
}

export function getDb(): DB {
  if (!db) throw new Error("DB not initialized");
  return db;
}

/** 关闭底层连接（flush WAL + 释放文件锁）。还原换库前调用，随后立即 relaunch。 */
export function closeDb(): void {
  db?.$client.close();
  db = undefined;
}
```

(Note: the old `import path from "node:path"` is no longer needed — remove it.)

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add src/main/db/migrations-path.ts src/main/db/migrations-path.test.ts src/main/db/instance.ts
git commit -m "feat(backup): add migrations-path helpers + closeDb"
```

---

## Task 4: Shared manifest schema + IPC contracts

**Files:**

- Create: `src/shared/backup.ts`
- Test: `src/shared/backup.test.ts`
- Modify: `src/shared/ipc.ts`

- [ ] **Step 1: Write the failing test**

`src/shared/backup.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { backupManifestSchema, BACKUP_FORMAT_VERSION } from "@shared/backup";

const valid = {
  formatVersion: BACKUP_FORMAT_VERSION,
  appVersion: "0.9.0",
  schemaHead: "0007_thing",
  createdAt: 1_700_000_000_000,
  bookCount: 3,
  includesApiKeys: true,
  dbSha256: "deadbeef",
};

describe("backupManifestSchema", () => {
  it("accepts a well-formed manifest", () => {
    expect(backupManifestSchema.parse(valid)).toEqual(valid);
  });

  it("rejects a missing field", () => {
    const { dbSha256, ...partial } = valid;
    expect(backupManifestSchema.safeParse(partial).success).toBe(false);
  });

  it("rejects a wrong type", () => {
    expect(backupManifestSchema.safeParse({ ...valid, bookCount: "3" }).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/shared/backup.test.ts`
Expected: FAIL ("Cannot find module @shared/backup").

- [ ] **Step 3: Implement `src/shared/backup.ts`**

```typescript
import { z } from "zod";

/** 备份包格式版本——格式演进的判别位。 */
export const BACKUP_FORMAT_VERSION = 1;

export const backupManifestSchema = z.object({
  formatVersion: z.number().int().positive(),
  appVersion: z.string(),
  /** 导出方最新迁移目录名（<timestamp>_<name>，字典序末位）；还原兼容判定依据。 */
  schemaHead: z.string(),
  createdAt: z.number().int().nonnegative(),
  bookCount: z.number().int().nonnegative(),
  includesApiKeys: z.boolean(),
  /** db 快照的 sha256，还原前完整性校验。 */
  dbSha256: z.string(),
});
export type BackupManifest = z.infer<typeof backupManifestSchema>;

/** backup:restore 入参——已 inspect 过的本地 zip 路径。 */
export const backupRestoreInput = z.object({ path: z.string().min(1) });
export type BackupRestoreInput = z.infer<typeof backupRestoreInput>;

/** backup:inspect 返回：备份预览 + 兼容性结论（供还原确认弹窗）。 */
export interface BackupInspection {
  path: string;
  manifest: BackupManifest;
  compatible: boolean;
  reason?: string;
}

/** backup:export 返回：写出的 zip 路径。 */
export interface BackupExportResult {
  path: string;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/shared/backup.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Add IPC contracts**

In `src/shared/ipc.ts`, add imports near the other domain imports (after line 50):

```typescript
import type { BackupExportResult, BackupInspection } from "@shared/backup";
import { backupRestoreInput } from "@shared/backup";
```

Add to the `C` object (after the `stats` block, before `// logging`):

```typescript
  // backup
  backupExport: def("backup:export", "invoke", z.void(), out<BackupExportResult | null>()),
  backupInspect: def("backup:inspect", "invoke", z.void(), out<BackupInspection | null>()),
  backupRestore: def("backup:restore", "invoke", backupRestoreInput, out<void>()),
```

- [ ] **Step 6: Typecheck + commit**

Run: `pnpm typecheck`
Expected: PASS.

```bash
git add src/shared/backup.ts src/shared/backup.test.ts src/shared/ipc.ts
git commit -m "feat(backup): add manifest schema + IPC contracts"
```

---

## Task 5: Pure core — `buildManifest`

**Files:**

- Create: `src/main/backup/manifest.ts`
- Test: `src/main/backup/manifest.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/backup/manifest.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/backup/manifest.test.ts`
Expected: FAIL ("Cannot find module @main/backup/manifest").

- [ ] **Step 3: Implement `src/main/backup/manifest.ts`**

```typescript
import { count } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { books } from "@main/db/schema";
import { BACKUP_FORMAT_VERSION, type BackupManifest } from "@shared/backup";

/** 组装备份 manifest。读 bookCount；其余由胶水层注入（schemaHead/dbSha256/appVersion）。 */
export function buildManifest(
  db: DB,
  opts: { appVersion: string; schemaHead: string; dbSha256: string },
): BackupManifest {
  const [{ c }] = db.select({ c: count() }).from(books).all();
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    appVersion: opts.appVersion,
    schemaHead: opts.schemaHead,
    createdAt: Date.now(),
    bookCount: c,
    includesApiKeys: true,
    dbSha256: opts.dbSha256,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/backup/manifest.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/backup/manifest.ts src/main/backup/manifest.test.ts
git commit -m "feat(backup): pure buildManifest"
```

---

## Task 6: Pure core — `checkRestoreCompatibility`

**Files:**

- Create: `src/main/backup/compat.ts`
- Test: `src/main/backup/compat.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/backup/compat.test.ts`:

```typescript
import { describe, expect, it } from "vitest";
import { checkRestoreCompatibility } from "@main/backup/compat";

const known = ["0001_a", "0002_b", "0003_c"];

describe("checkRestoreCompatibility", () => {
  it("compatible when bundle head equals current head", () => {
    expect(checkRestoreCompatibility("0003_c", known).compatible).toBe(true);
  });

  it("compatible when bundle is older (head is an earlier known migration)", () => {
    expect(checkRestoreCompatibility("0001_a", known).compatible).toBe(true);
  });

  it("incompatible when bundle head is unknown (newer app)", () => {
    const r = checkRestoreCompatibility("0004_d", known);
    expect(r.compatible).toBe(false);
    expect(r.reason).toBeTruthy();
  });

  it("incompatible when bundle head is empty", () => {
    expect(checkRestoreCompatibility("", known).compatible).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/backup/compat.test.ts`
Expected: FAIL ("Cannot find module @main/backup/compat").

- [ ] **Step 3: Implement `src/main/backup/compat.ts`**

```typescript
/** 还原版本兼容判定（纯函数）：备份的 schemaHead 必须 ∈ 当前 app 的迁移目录集。
 * 命中 = 备份 schema 等于或早于当前（重启后迁移补齐）；未命中 = 备份来自更新版本，无法降级。 */
export function checkRestoreCompatibility(
  bundleSchemaHead: string,
  knownMigrationDirs: string[],
): { compatible: boolean; reason?: string } {
  if (!bundleSchemaHead) {
    return { compatible: false, reason: "backup manifest has no schema head" };
  }
  if (knownMigrationDirs.includes(bundleSchemaHead)) return { compatible: true };
  return {
    compatible: false,
    reason: `backup is from a newer app version (unknown migration ${bundleSchemaHead}); cannot downgrade`,
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/backup/compat.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/backup/compat.ts src/main/backup/compat.test.ts
git commit -m "feat(backup): pure checkRestoreCompatibility"
```

---

## Task 7: Archive helpers (sha256 / create / read / extract)

**Files:**

- Create: `src/main/backup/archive.ts`
- Test: `src/main/backup/archive.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/backup/archive.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createBackupZip, extractZip, readZipEntryText, sha256File } from "@main/backup/archive";

function tmp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

describe("archive helpers", () => {
  it("sha256File hashes deterministically", async () => {
    const dir = tmp("arch-hash-");
    const f = path.join(dir, "x.bin");
    writeFileSync(f, "hello");
    // sha256("hello")
    expect(await sha256File(f)).toBe(
      "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824",
    );
  });

  it("zip → read manifest → extract roundtrips db + books", async () => {
    const src = tmp("arch-src-");
    const snapshot = path.join(src, "snap.db");
    writeFileSync(snapshot, "DBDATA");
    const booksDir = path.join(src, "books");
    mkdirSync(booksDir);
    writeFileSync(path.join(booksDir, "a.epub"), "BOOK-A");

    const zipPath = path.join(src, "out.zip");
    await createBackupZip({
      zipPath,
      snapshotPath: snapshot,
      booksDir,
      manifest: { hello: "world" },
    });
    expect(existsSync(zipPath)).toBe(true);

    const manifestText = await readZipEntryText(zipPath, "manifest.json");
    expect(JSON.parse(manifestText)).toEqual({ hello: "world" });

    const dest = tmp("arch-dest-");
    await extractZip(zipPath, dest);
    expect(readFileSync(path.join(dest, "marginalia.db"), "utf8")).toBe("DBDATA");
    expect(readFileSync(path.join(dest, "books", "a.epub"), "utf8")).toBe("BOOK-A");
  });

  it("readZipEntryText rejects a missing entry", async () => {
    const src = tmp("arch-miss-");
    const snapshot = path.join(src, "snap.db");
    writeFileSync(snapshot, "X");
    const booksDir = path.join(src, "books");
    mkdirSync(booksDir);
    const zipPath = path.join(src, "out.zip");
    await createBackupZip({ zipPath, snapshotPath: snapshot, booksDir, manifest: {} });
    await expect(readZipEntryText(zipPath, "nope.json")).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/backup/archive.test.ts`
Expected: FAIL ("Cannot find module @main/backup/archive").

- [ ] **Step 3: Implement `src/main/backup/archive.ts`**

```typescript
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import archiver from "archiver";
import yauzl from "yauzl";
import { createLogger } from "@main/logger";

const log = createLogger("backup");

/** 流式算文件 sha256（十六进制）。 */
export function sha256File(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const h = createHash("sha256");
    const s = createReadStream(filePath);
    s.on("data", (c) => h.update(c));
    s.on("end", () => resolve(h.digest("hex")));
    s.on("error", reject);
  });
}

/** 写备份 zip：db 快照 → marginalia.db；books/ 目录；manifest.json。流式，大书库不入内存。 */
export function createBackupZip(opts: {
  zipPath: string;
  snapshotPath: string;
  booksDir: string;
  manifest: unknown;
}): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(opts.zipPath);
    const archive = archiver("zip", { zlib: { level: 9 } });
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("warning", (e) => log.warn("archive warning", e));
    archive.on("error", reject);
    archive.pipe(output);
    archive.file(opts.snapshotPath, { name: "marginalia.db" });
    if (existsSync(opts.booksDir)) archive.directory(opts.booksDir, "books");
    archive.append(JSON.stringify(opts.manifest, null, 2), { name: "manifest.json" });
    void archive.finalize();
  });
}

/** 读 zip 内单条目为 utf8 文本；条目不存在时 reject。 */
export function readZipEntryText(zipPath: string, entryName: string): Promise<string> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("zip open failed"));
      let found = false;
      zip.on("entry", (entry) => {
        if (entry.fileName !== entryName) return zip.readEntry();
        found = true;
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error("zip stream failed"));
          const chunks: Buffer[] = [];
          stream.on("data", (c: Buffer) => chunks.push(c));
          stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
          stream.on("error", reject);
        });
      });
      zip.on("end", () => {
        if (!found) reject(new Error(`zip entry not found: ${entryName}`));
      });
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}

/** 解包整个 zip 到 destDir（含 zip-slip 防御）。 */
export function extractZip(zipPath: string, destDir: string): Promise<void> {
  const root = path.resolve(destDir);
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zip) => {
      if (err || !zip) return reject(err ?? new Error("zip open failed"));
      zip.on("entry", (entry) => {
        const outPath = path.resolve(root, entry.fileName);
        if (outPath !== root && !outPath.startsWith(root + path.sep)) {
          return reject(new Error(`unsafe zip entry path: ${entry.fileName}`));
        }
        if (entry.fileName.endsWith("/")) {
          mkdirSync(outPath, { recursive: true });
          return zip.readEntry();
        }
        mkdirSync(path.dirname(outPath), { recursive: true });
        zip.openReadStream(entry, (e, stream) => {
          if (e || !stream) return reject(e ?? new Error("zip stream failed"));
          const ws = createWriteStream(outPath);
          stream.on("error", reject);
          ws.on("error", reject);
          ws.on("close", () => zip.readEntry());
          stream.pipe(ws);
        });
      });
      zip.on("end", () => resolve());
      zip.on("error", reject);
      zip.readEntry();
    });
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/backup/archive.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/backup/archive.ts src/main/backup/archive.test.ts
git commit -m "feat(backup): archive helpers (sha256/create/read/extract)"
```

---

## Task 8: Restore fs helpers (`verifyBookFiles`, `applyRestore`)

**Files:**

- Create: `src/main/backup/restore.ts`
- Test: `src/main/backup/restore.test.ts`

- [ ] **Step 1: Write the failing test**

`src/main/backup/restore.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { storedBookPath } from "@main/library/book-files";
import { applyRestore, verifyBookFiles } from "@main/backup/restore";

function tmp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}
function seedDb(file: string, books: { id: string; format: string }[]): void {
  const db = new Database(file);
  db.exec("create table books (id text primary key, format text not null default 'epub')");
  const ins = db.prepare("insert into books (id, format) values (?, ?)");
  for (const b of books) ins.run(b.id, b.format);
  db.close();
}

describe("verifyBookFiles", () => {
  it("ok when every book row has its file", () => {
    const dir = tmp("ver-ok-");
    const dbFile = path.join(dir, "marginalia.db");
    seedDb(dbFile, [{ id: "b1", format: "epub" }]);
    const booksDir = path.join(dir, "books");
    mkdirSync(booksDir);
    writeFileSync(storedBookPath(booksDir, "b1", "epub"), "x");
    expect(verifyBookFiles(dbFile, booksDir)).toEqual({ ok: true, missing: [] });
  });

  it("reports missing book ids", () => {
    const dir = tmp("ver-miss-");
    const dbFile = path.join(dir, "marginalia.db");
    seedDb(dbFile, [
      { id: "b1", format: "epub" },
      { id: "b2", format: "pdf" },
    ]);
    const booksDir = path.join(dir, "books");
    mkdirSync(booksDir);
    writeFileSync(storedBookPath(booksDir, "b1", "epub"), "x");
    expect(verifyBookFiles(dbFile, booksDir)).toEqual({ ok: false, missing: ["b2"] });
  });
});

describe("applyRestore", () => {
  it("moves current data to pre-restore and staged into place", async () => {
    const dataDir = tmp("ar-data-");
    const booksDir = path.join(dataDir, "books");
    mkdirSync(booksDir);
    writeFileSync(path.join(dataDir, "marginalia.db"), "OLD-DB");
    writeFileSync(path.join(booksDir, "old.epub"), "OLD-BOOK");

    const stagingDir = tmp("ar-stage-");
    writeFileSync(path.join(stagingDir, "marginalia.db"), "NEW-DB");
    const stagedBooks = path.join(stagingDir, "books");
    mkdirSync(stagedBooks);
    writeFileSync(path.join(stagedBooks, "new.epub"), "NEW-BOOK");

    const preRestoreTarget = path.join(tmp("ar-pre-"), "snap");

    await applyRestore({
      dataDir,
      booksDir,
      stagingDir,
      preRestoreTarget,
      dbFileName: "marginalia.db",
    });

    // current replaced by staged
    expect(readFileSync(path.join(dataDir, "marginalia.db"), "utf8")).toBe("NEW-DB");
    expect(readFileSync(path.join(booksDir, "new.epub"), "utf8")).toBe("NEW-BOOK");
    expect(existsSync(path.join(booksDir, "old.epub"))).toBe(false);
    // old preserved in pre-restore
    expect(readFileSync(path.join(preRestoreTarget, "marginalia.db"), "utf8")).toBe("OLD-DB");
    expect(readFileSync(path.join(preRestoreTarget, "books", "old.epub"), "utf8")).toBe("OLD-BOOK");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/backup/restore.test.ts`
Expected: FAIL ("Cannot find module @main/backup/restore").

- [ ] **Step 3: Implement `src/main/backup/restore.ts`**

```typescript
import { existsSync } from "node:fs";
import { mkdir, rename } from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { storedBookPath, type BookFormat } from "@main/library/book-files";

/** 校验 staged DB 引用的每本书文件在 staged books/ 中存在；返回缺失 bookId 列表。 */
export function verifyBookFiles(
  stagedDbPath: string,
  stagedBooksDir: string,
): { ok: boolean; missing: string[] } {
  const sqlite = new Database(stagedDbPath, { readonly: true });
  try {
    const rows = sqlite.prepare("select id, format from books").all() as {
      id: string;
      format: string;
    }[];
    const missing = rows
      .filter((r) => !existsSync(storedBookPath(stagedBooksDir, r.id, r.format as BookFormat)))
      .map((r) => r.id);
    return { ok: missing.length === 0, missing };
  } finally {
    sqlite.close();
  }
}

/** 整体替换：当前 db 三件套 + books/ 移入 preRestoreTarget，staged db + books/ 移入 dataDir。
 * staging 与 dataDir 同盘（userData/tmp），rename 不跨设备。调用前须已 closeDb() 释放锁。 */
export async function applyRestore(opts: {
  dataDir: string;
  booksDir: string;
  stagingDir: string;
  preRestoreTarget: string;
  dbFileName: string;
}): Promise<void> {
  await mkdir(opts.preRestoreTarget, { recursive: true });

  // 1) 当前数据 → pre-restore 安全副本
  for (const f of [opts.dbFileName, `${opts.dbFileName}-wal`, `${opts.dbFileName}-shm`]) {
    const src = path.join(opts.dataDir, f);
    if (existsSync(src)) await rename(src, path.join(opts.preRestoreTarget, f));
  }
  if (existsSync(opts.booksDir)) {
    await rename(opts.booksDir, path.join(opts.preRestoreTarget, "books"));
  }

  // 2) staged → 正式位置
  await rename(
    path.join(opts.stagingDir, opts.dbFileName),
    path.join(opts.dataDir, opts.dbFileName),
  );
  const stagedBooks = path.join(opts.stagingDir, "books");
  if (existsSync(stagedBooks)) await rename(stagedBooks, opts.booksDir);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/backup/restore.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add src/main/backup/restore.ts src/main/backup/restore.test.ts
git commit -m "feat(backup): restore fs helpers (verifyBookFiles/applyRestore)"
```

---

## Task 9: Backup service orchestration

**Files:**

- Create: `src/main/backup/backup-service.ts`
- Test: `src/main/backup/backup-service.test.ts`

The service wires pure core + helpers. It takes injected paths/handles so it stays headless-testable; only dialogs/relaunch live in the handler (Task 10).

- [ ] **Step 1: Write the failing test (export → inspect → restore roundtrip)**

`src/main/backup/backup-service.test.ts`:

```typescript
import { mkdtempSync, mkdirSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations, type DB } from "@main/db/client";
import { books } from "@main/db/schema";
import { storedBookPath } from "@main/library/book-files";
import { exportBackup, inspectBackup, restoreBackup } from "@main/backup/backup-service";
import { latestMigrationDir, listMigrationDirs } from "@main/db/migrations-path";

const MIG = path.resolve(process.cwd(), "src/main/db/migrations");
const HEAD = latestMigrationDir(MIG);
const KNOWN = listMigrationDirs(MIG);

function tmp(prefix: string): string {
  return mkdtempSync(path.join(tmpdir(), prefix));
}

// build a real on-disk source userData (db + one book file), return its db handle + dirs
function makeSource(): { db: DB; dataDir: string; booksDir: string; tmpDir: string } {
  const dataDir = tmp("svc-src-");
  const dbPath = path.join(dataDir, "marginalia.db");
  const db = createDb(dbPath);
  runMigrations(db, MIG);
  db.insert(books).values({ id: "b1", format: "epub" }).run();
  const booksDir = path.join(dataDir, "books");
  mkdirSync(booksDir);
  writeFileSync(storedBookPath(booksDir, "b1", "epub"), "BOOK-BYTES");
  const tmpDir = path.join(dataDir, "tmp");
  return { db, dataDir, booksDir, tmpDir };
}

describe("backup-service roundtrip", () => {
  let src: ReturnType<typeof makeSource>;
  let zipPath: string;
  beforeEach(() => {
    src = makeSource();
    zipPath = path.join(tmp("svc-zip-"), "backup.zip");
  });

  it("exports a zip with a manifest reflecting the library", async () => {
    const res = await exportBackup({
      db: src.db,
      rawSqlite: src.db.$client,
      zipPath,
      booksDir: src.booksDir,
      tmpDir: src.tmpDir,
      appVersion: "9.9.9",
      schemaHead: HEAD,
    });
    expect(res.path).toBe(zipPath);
    expect(existsSync(zipPath)).toBe(true);

    const ins = await inspectBackup({ zipPath, knownMigrationDirs: KNOWN });
    expect(ins.manifest.bookCount).toBe(1);
    expect(ins.manifest.appVersion).toBe("9.9.9");
    expect(ins.manifest.schemaHead).toBe(HEAD);
    expect(ins.compatible).toBe(true);
  });

  it("inspect flags an incompatible (newer) backup", async () => {
    await exportBackup({
      db: src.db,
      rawSqlite: src.db.$client,
      zipPath,
      booksDir: src.booksDir,
      tmpDir: src.tmpDir,
      appVersion: "9.9.9",
      schemaHead: "9999_from_the_future",
    });
    const ins = await inspectBackup({ zipPath, knownMigrationDirs: KNOWN });
    expect(ins.compatible).toBe(false);
    expect(ins.reason).toBeTruthy();
  });

  it("restores the bundle into a fresh dataDir and preserves old data", async () => {
    await exportBackup({
      db: src.db,
      rawSqlite: src.db.$client,
      zipPath,
      booksDir: src.booksDir,
      tmpDir: src.tmpDir,
      appVersion: "9.9.9",
      schemaHead: HEAD,
    });
    src.db.$client.close();

    // target userData with different existing content
    const dataDir = tmp("svc-dst-");
    const booksDir = path.join(dataDir, "books");
    mkdirSync(booksDir);
    writeFileSync(path.join(dataDir, "marginalia.db"), "OLD");
    writeFileSync(storedBookPath(booksDir, "old", "epub"), "OLD-BOOK");
    const tmpDir = path.join(dataDir, "tmp");
    const preRestoreDir = path.join(dataDir, "pre-restore");

    let closed = false;
    await restoreBackup({
      zipPath,
      dataDir,
      booksDir,
      tmpDir,
      preRestoreDir,
      dbFileName: "marginalia.db",
      knownMigrationDirs: KNOWN,
      stamp: "20260609-000000",
      closeDb: () => {
        closed = true;
      },
    });

    expect(closed).toBe(true);
    // restored book file present
    expect(readFileSync(storedBookPath(booksDir, "b1", "epub"), "utf8")).toBe("BOOK-BYTES");
    // restored db opens and has the book
    const restored = createDb(path.join(dataDir, "marginalia.db"));
    runMigrations(restored, MIG);
    expect(restored.select().from(books).all().length).toBe(1);
    restored.$client.close();
    // old data preserved under pre-restore/<stamp>
    expect(readFileSync(path.join(preRestoreDir, "20260609-000000", "marginalia.db"), "utf8")).toBe(
      "OLD",
    );
  });

  it("refuses restore on dbSha256 mismatch (corrupt bundle)", async () => {
    // craft a bundle whose manifest.dbSha256 deliberately does not match its db snapshot
    const craft = tmp("svc-corrupt-");
    const snap = path.join(craft, "snap.db");
    const cdb = createDb(snap);
    runMigrations(cdb, MIG);
    cdb.$client.close();
    const cbooks = path.join(craft, "books");
    mkdirSync(cbooks);
    const badZip = path.join(craft, "bad.zip");
    await createBackupZip({
      zipPath: badZip,
      snapshotPath: snap,
      booksDir: cbooks,
      manifest: {
        formatVersion: 1,
        appVersion: "x",
        schemaHead: HEAD,
        createdAt: 1,
        bookCount: 0,
        includesApiKeys: true,
        dbSha256: "0".repeat(64), // wrong on purpose
      },
    });

    const dataDir = tmp("svc-corrupt-dst-");
    let closed = false;
    await expect(
      restoreBackup({
        zipPath: badZip,
        dataDir,
        booksDir: path.join(dataDir, "books"),
        tmpDir: path.join(dataDir, "tmp"),
        preRestoreDir: path.join(dataDir, "pre-restore"),
        dbFileName: "marginalia.db",
        knownMigrationDirs: KNOWN,
        stamp: "corrupt",
        closeDb: () => {
          closed = true;
        },
      }),
    ).rejects.toThrow(/checksum mismatch/);
    // refused before touching the live DB / current data
    expect(closed).toBe(false);
    expect(existsSync(path.join(dataDir, "marginalia.db"))).toBe(false);
  });
});
```

This needs `createBackupZip` imported in the test — add it to the import from `@main/backup/archive`:

```typescript
import { createBackupZip } from "@main/backup/archive";
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test src/main/backup/backup-service.test.ts`
Expected: FAIL ("Cannot find module @main/backup/backup-service").

- [ ] **Step 3: Implement `src/main/backup/backup-service.ts`**

```typescript
import { mkdir, rm, unlink } from "node:fs/promises";
import path from "node:path";
import type Database from "better-sqlite3";
import type { DB } from "@main/db/client";
import { createLogger } from "@main/logger";
import {
  backupManifestSchema,
  type BackupExportResult,
  type BackupInspection,
} from "@shared/backup";
import { buildManifest } from "@main/backup/manifest";
import { checkRestoreCompatibility } from "@main/backup/compat";
import { createBackupZip, extractZip, readZipEntryText, sha256File } from "@main/backup/archive";
import { applyRestore, verifyBookFiles } from "@main/backup/restore";

const log = createLogger("backup");

/** 导出：.backup() 一致快照 → 算 sha256 → buildManifest → 流式 zip → 清临时。 */
export async function exportBackup(opts: {
  db: DB;
  rawSqlite: Database.Database;
  zipPath: string;
  booksDir: string;
  tmpDir: string;
  appVersion: string;
  schemaHead: string;
}): Promise<BackupExportResult> {
  await mkdir(opts.tmpDir, { recursive: true });
  const snapshotPath = path.join(opts.tmpDir, `export-${Date.now()}.db`);
  try {
    await opts.rawSqlite.backup(snapshotPath);
    const dbSha256 = await sha256File(snapshotPath);
    const manifest = buildManifest(opts.db, {
      appVersion: opts.appVersion,
      schemaHead: opts.schemaHead,
      dbSha256,
    });
    await createBackupZip({
      zipPath: opts.zipPath,
      snapshotPath,
      booksDir: opts.booksDir,
      manifest,
    });
    return { path: opts.zipPath };
  } finally {
    await unlink(snapshotPath).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") log.warn("export temp cleanup failed", e);
    });
  }
}

/** 检视：读 manifest.json → Zod 校验 → 兼容性判定。 */
export async function inspectBackup(opts: {
  zipPath: string;
  knownMigrationDirs: string[];
}): Promise<BackupInspection> {
  const raw = await readZipEntryText(opts.zipPath, "manifest.json");
  const manifest = backupManifestSchema.parse(JSON.parse(raw));
  const { compatible, reason } = checkRestoreCompatibility(
    manifest.schemaHead,
    opts.knownMigrationDirs,
  );
  return { path: opts.zipPath, manifest, compatible, reason };
}

/** 还原（整体替换）：解包到 staging → 校验完整性/兼容性 → closeDb → applyRestore。relaunch 由 handler 做。 */
export async function restoreBackup(opts: {
  zipPath: string;
  dataDir: string;
  booksDir: string;
  tmpDir: string;
  preRestoreDir: string;
  dbFileName: string;
  knownMigrationDirs: string[];
  stamp: string;
  closeDb: () => void;
}): Promise<void> {
  const stagingDir = path.join(opts.tmpDir, `restore-${opts.stamp}`);
  await rm(stagingDir, { recursive: true, force: true });
  await mkdir(stagingDir, { recursive: true });
  try {
    await extractZip(opts.zipPath, stagingDir);

    // 兼容性（manifest 必在、schemaHead 已知）
    const manifestRaw = await readZipEntryText(opts.zipPath, "manifest.json");
    const manifest = backupManifestSchema.parse(JSON.parse(manifestRaw));
    const compat = checkRestoreCompatibility(manifest.schemaHead, opts.knownMigrationDirs);
    if (!compat.compatible) throw new Error(`restore refused: ${compat.reason}`);

    // 完整性：db sha256 + 书文件齐全
    const stagedDb = path.join(stagingDir, opts.dbFileName);
    const stagedBooks = path.join(stagingDir, "books");
    const sha = await sha256File(stagedDb);
    if (sha !== manifest.dbSha256) {
      throw new Error("restore refused: backup database checksum mismatch (corrupt bundle)");
    }
    const books = verifyBookFiles(stagedDb, stagedBooks);
    if (!books.ok) {
      throw new Error(`restore refused: backup is missing book files: ${books.missing.join(", ")}`);
    }

    // 换库前关连接释放锁，再整体替换
    opts.closeDb();
    await applyRestore({
      dataDir: opts.dataDir,
      booksDir: opts.booksDir,
      stagingDir,
      preRestoreTarget: path.join(opts.preRestoreDir, opts.stamp),
      dbFileName: opts.dbFileName,
    });
  } finally {
    await rm(stagingDir, { recursive: true, force: true }).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") log.warn("restore staging cleanup failed", e);
    });
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test src/main/backup/backup-service.test.ts`
Expected: PASS (export+inspect, incompat, restore roundtrip, corrupt-bundle refusal).

- [ ] **Step 5: Commit**

```bash
git add src/main/backup/backup-service.ts src/main/backup/backup-service.test.ts
git commit -m "feat(backup): export/inspect/restore service orchestration"
```

---

## Task 10: IPC handlers + main.ts wiring + bindings coverage

**Files:**

- Create: `src/main/ipc/backup-handlers.ts`
- Modify: `src/main.ts`, `src/main/ipc/bindings-coverage.test.ts`

- [ ] **Step 1: Implement `src/main/ipc/backup-handlers.ts`**

```typescript
import path from "node:path";
import { app, BrowserWindow, dialog } from "electron";
import { C } from "@shared/ipc";
import { appService } from "@main/app";
import { closeDb, getDb } from "@main/db/instance";
import {
  listMigrationDirs,
  latestMigrationDir,
  resolveMigrationsFolder,
} from "@main/db/migrations-path";
import { bind, register, type Binding } from "@main/ipc/registry";
import { exportBackup, inspectBackup, restoreBackup } from "@main/backup/backup-service";
import { createLogger } from "@main/logger";

const log = createLogger("backup");

function timestamp(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(
    d.getMinutes(),
  )}${p(d.getSeconds())}`;
}

export const backupBindings: Binding[] = [
  bind(C.backupExport, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const stamp = timestamp();
    const opts = {
      defaultPath: `marginalia-backup-${stamp}.zip`,
      filters: [{ name: "Marginalia Backup", extensions: ["zip"] }],
    };
    const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
    if (r.canceled || !r.filePath) return null;
    const folder = resolveMigrationsFolder();
    const res = await exportBackup({
      db: getDb(),
      rawSqlite: getDb().$client,
      zipPath: r.filePath,
      booksDir: appService.getPath("booksDir"),
      tmpDir: appService.getPath("tmpDir"),
      appVersion: app.getVersion(),
      schemaHead: latestMigrationDir(folder),
    });
    log.info(`backup exported to ${res.path}`);
    return res;
  }),

  bind(C.backupInspect, async () => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      properties: ["openFile" as const],
      filters: [{ name: "Marginalia Backup", extensions: ["zip"] }],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || r.filePaths.length === 0) return null;
    return inspectBackup({
      zipPath: r.filePaths[0],
      knownMigrationDirs: listMigrationDirs(resolveMigrationsFolder()),
    });
  }),

  bind(C.backupRestore, async (input) => {
    await restoreBackup({
      zipPath: input.path,
      dataDir: path.dirname(appService.getPath("dbFile")),
      booksDir: appService.getPath("booksDir"),
      tmpDir: appService.getPath("tmpDir"),
      preRestoreDir: appService.getPath("preRestoreDir"),
      dbFileName: path.basename(appService.getPath("dbFile")),
      knownMigrationDirs: listMigrationDirs(resolveMigrationsFolder()),
      stamp: timestamp(),
      closeDb,
    });
    log.info("backup restored; relaunching");
    app.relaunch();
    app.exit(0);
  }),
];

export function registerBackupHandlers(): void {
  register(backupBindings);
}
```

> Note: `dataDir` is derived as `path.dirname(getPath("dbFile"))` because AppService intentionally keeps the raw `dataDir` private; the db file lives at the dataDir root, so its dirname is the root.

- [ ] **Step 2: Wire into `src/main.ts`**

Add the import alongside the other handler imports (near line 19):

```typescript
import { registerBackupHandlers } from "@main/ipc/backup-handlers";
```

Add the registration call alongside the others (after `registerStatsHandlers();`, ~line 147):

```typescript
registerBackupHandlers();
```

- [ ] **Step 3: Add `backupBindings` to the coverage test**

In `src/main/ipc/bindings-coverage.test.ts`, add the import and spread:

```typescript
import { backupBindings } from "@main/ipc/backup-handlers";
```

```typescript
const allBindings = [
  ...appBindings,
  ...libraryBindings,
  ...settingsBindings,
  ...chatBindings,
  ...annotationsBindings,
  ...preferencesBindings,
  ...aiBindings,
  ...logBindings,
  ...statsBindings,
  ...backupBindings,
];
```

- [ ] **Step 4: Typecheck + run coverage test**

Run: `pnpm typecheck && pnpm test src/main/ipc/bindings-coverage.test.ts`
Expected: PASS (every invoke contract — now incl. the 3 backup channels — has exactly one binding).

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/backup-handlers.ts src/main.ts src/main/ipc/bindings-coverage.test.ts
git commit -m "feat(backup): IPC handlers + main wiring + coverage"
```

---

## Task 11: Preload API surface

**Files:**

- Modify: `src/preload-api.ts`

- [ ] **Step 1: Add the `backup` group**

In `src/preload-api.ts`, inside the object returned by `createApi`, add after the `stats` block:

```typescript
    backup: {
      /** 导出备份（主进程开 saveDialog）；用户取消返回 null。 */
      export: inv(C.backupExport),
      /** 选包并检视（主进程开 openDialog）；取消返回 null，含兼容性结论供确认弹窗。 */
      inspect: inv(C.backupInspect),
      /** 整体替换还原；成功后主进程立即 relaunch（此调用不会正常 resolve）。 */
      restore: inv(C.backupRestore),
    },
```

- [ ] **Step 2: Typecheck**

Run: `pnpm typecheck`
Expected: PASS. (`RendererApi` now exposes `window.api.backup.*`.)

- [ ] **Step 3: Commit**

```bash
git add src/preload-api.ts
git commit -m "feat(backup): expose window.api.backup"
```

---

## Task 12: Renderer UI — backup/restore in Advanced settings

**Files:**

- Modify: `src/renderer/settings/AdvancedSettings.tsx`
- Modify (generated): `src/shared/i18n/locales/*` via `pnpm i18n:extract`

Reuses the existing "日志 / 打开日志文件夹" row pattern. Restore uses `window.api.backup.inspect()` → confirm dialog → `window.api.backup.restore()`. Use the existing Base UI `AlertDialog`/`Dialog` primitive if present; otherwise `window.confirm` is acceptable for v1 (note below).

- [ ] **Step 1: Check available dialog primitive**

Run: `ls src/renderer/components/ui | grep -iE "dialog|alert"`
Expected: shows a dialog component (e.g. `alert-dialog.tsx` or `dialog.tsx`). If one exists, use it for the confirm step. If none exists, use `window.confirm(...)` for the confirmation (acceptable for v1; a styled dialog can be a follow-up). The code below uses `window.confirm` to stay self-contained; swap to the project dialog if available.

- [ ] **Step 2: Add backup/restore section to `AdvancedSettings.tsx`**

Add imports at the top:

```typescript
import { useState } from "react";
import { Download, Upload } from "lucide-react";
```

Inside the component (after the existing `setStepLimit` hooks), add handlers:

```typescript
const [busy, setBusy] = useState(false);

const onExport = async () => {
  setBusy(true);
  try {
    const res = await window.api.backup.export();
    if (res)
      window.alert(t("settings.backup.exportDone", "备份已导出：{{path}}", { path: res.path }));
  } catch {
    window.alert(t("settings.backup.exportFailed", "备份导出失败"));
  } finally {
    setBusy(false);
  }
};

const onRestore = async () => {
  setBusy(true);
  try {
    const ins = await window.api.backup.inspect();
    if (!ins) return; // 用户取消
    if (!ins.compatible) {
      window.alert(
        t("settings.backup.incompatible", "无法还原：备份来自更新版本（{{reason}}）", {
          reason: ins.reason ?? "",
        }),
      );
      return;
    }
    const when = new Date(ins.manifest.createdAt).toLocaleString();
    const ok = window.confirm(
      t(
        "settings.backup.confirmRestore",
        "将用此备份整体替换当前全部数据（{{count}} 本书，导出于 {{when}}）。当前数据会先存入 pre-restore 副本，随后应用将重启。继续？",
        { count: ins.manifest.bookCount, when },
      ),
    );
    if (!ok) return;
    await window.api.backup.restore({ path: ins.path });
    // 成功后主进程 relaunch，正常不会执行到这里。
  } catch {
    window.alert(t("settings.backup.restoreFailed", "还原失败"));
  } finally {
    setBusy(false);
  }
};
```

Add the UI section just before the closing `</section>`, after the logs row:

```tsx
<div className="space-y-2">
  <span className="text-sm font-medium">{t("settings.backup.title", "备份与还原")}</span>
  <p className="text-[11px] leading-relaxed text-muted-foreground">
    {t(
      "settings.backup.warning",
      "备份包含全部书籍、标注、进度、会话与设置；其中 API key 以明文随包导出，请妥善保管。",
    )}
  </p>
  <div className="flex gap-2">
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void onExport()}>
      <Download />
      {t("settings.backup.export", "导出备份")}
    </Button>
    <Button variant="outline" size="sm" disabled={busy} onClick={() => void onRestore()}>
      <Upload />
      {t("settings.backup.restore", "还原备份")}
    </Button>
  </div>
</div>
```

- [ ] **Step 3: Typecheck**

Run: `pnpm typecheck`
Expected: PASS.

- [ ] **Step 4: Extract i18n keys**

Run: `pnpm i18n:extract`
Expected: new `settings.backup.*` keys appear in the primary locale. Then run `pnpm i18n:lint` and confirm no missing-key errors for these keys (translate non-primary locales as the repo convention dictates, or leave for the i18n pass).

- [ ] **Step 5: Lint + commit**

Run: `pnpm lint`
Expected: clean.

```bash
git add src/renderer/settings/AdvancedSettings.tsx src/shared/i18n/locales
git commit -m "feat(backup): backup/restore UI in advanced settings"
```

---

## Task 13: Full test sweep, changeset, smoke

**Files:**

- Create: `.changeset/data-backup-restore.md`

- [ ] **Step 1: Full headless test + typecheck + lint**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: all PASS (new backup tests + the whole suite green; better-sqlite3 Electron ABI intact).

- [ ] **Step 2: Write the changeset**

`.changeset/data-backup-restore.md`:

```markdown
---
"marginalia": minor
---

Add data backup & restore: export your whole library (books, annotations, reading progress, conversations, settings) to a single zip, and restore it on any machine. Restore replaces current data after a confirmation and keeps a pre-restore safety copy, then relaunches. Backups include your provider API keys in plaintext — the export dialog warns you to keep the file private.
```

- [ ] **Step 3: Commit changeset**

```bash
git add .changeset/data-backup-restore.md
git commit -m "chore(backup): changeset for data backup & restore"
```

- [ ] **Step 4: Smoke test the real app (manual)**

Per CLAUDE.md, packaged/dev smoke with an isolated userData:

1. Run `pnpm start` (dev). Import at least one book so `books/` is non-empty.
2. Settings → 高级 → 导出备份. Confirm a `marginalia-backup-*.zip` is written; verify with `unzip -l <file>` that it contains `manifest.json`, `marginalia.db`, and `books/`.
3. Delete that book in the library.
4. Settings → 高级 → 还原备份, pick the zip, confirm. App should relaunch and the deleted book should be back.
5. Confirm a `pre-restore/<stamp>/` folder exists under the dev userData (`marginalia-dev`).

Document the result (pass/fail + any output) when reporting completion.

---

## Self-Review notes (author)

- **Spec coverage:** §2 decisions → Tasks 1–12; §3 architecture (shared/pure/glue) → Tasks 4/5-6/7-9; §4 manifest → Task 4; §5 flows → Tasks 9-10-12; §6 errors (compat/integrity/bad-zip) → Tasks 6/9; §7 testing → unit tests in 3-9 + smoke in 13; §8 UI → Task 12. All covered.
- **`.backup()` ABI:** export uses `db.$client.backup()` — better-sqlite3 stays Electron ABI (Task 1 Step 2 verifies).
- **Date.now/new Date:** used in app code (manifest createdAt, handler timestamp) — fine; the workflow-script ban does not apply to app runtime.
- **Type consistency:** `applyRestore` param `dbFileName`, `restoreBackup` passes `path.basename(getPath("dbFile"))`; `exportBackup`/`restoreBackup` paths all sourced from `appService.getPath(...)`; manifest fields match `backupManifestSchema` everywhere.
- **Open follow-ups (not in scope, see spec §9):** styled confirm dialog (vs window.confirm), pre-restore auto-cleanup, encryption, exclude-keys toggle.
