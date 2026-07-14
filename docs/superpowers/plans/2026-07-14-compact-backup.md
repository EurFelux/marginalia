# Compact Backup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a compact backup that contains the complete SQLite snapshot but omits original EPUB/PDF files, while keeping restore semantics snapshot-based and preserving the destination `books/` directory during compact restore.

**Architecture:** Evolve the existing zip manifest to version 2 with an explicit `kind: "full" | "compact"`, while normalizing legacy v1 packages to `full`. Reuse the existing online SQLite snapshot, checksum, staging, and relaunch pipeline; only archive inclusion and restore file swapping branch by the explicit kind. The renderer exposes compact export as the primary half of one split button and full export in its dropdown half.

**Tech Stack:** Electron 41.7.1, TypeScript 6, Zod 4, better-sqlite3/Drizzle, archiver/yauzl, React 19, Base UI/shadcn components, i18next, Vitest 4.

## Global Constraints

- Main process owns all backup/restore behavior; renderer only presents UI and invokes typed IPC.
- `src/shared/backup.ts` and `src/shared/ipc.ts` remain the Zod/type single source for the contract.
- Compact means “complete SQLite snapshot minus `books/`”; settings, providers, plaintext API keys, covers/blobs, progress, annotations, notes, summaries, conversations, memories, stats, and app metadata remain included.
- Restore never merges: full replaces DB + `books/`; compact replaces DB and must not move, create, delete, or overwrite the destination `books/`.
- New v2 manifests require `kind`; legacy v1 manifests normalize to `kind: "full"`; future format versions are rejected.
- Keep Electron pinned to `41.7.1`; do not change better-sqlite3, Drizzle, or pnpm configuration.
- New time code uses `Temporal`, with `Temporal.Now.*()` confined to Electron glue and explicit `Temporal.ZonedDateTime` injected into pure formatters.
- UI uses Tailwind classes and the existing Base UI/shadcn style; no static inline styles and no handwritten `useCallback`/`useMemo`.
- Diagnostic logging uses `createLogger("backup")`; IPC catch-all owns thrown-error logging.
- User-facing copy is i18n-backed in English and Simplified Chinese.
- Spec: `docs/superpowers/specs/2026-07-14-compact-backup-design.md`; issue: #104.

---

## File Structure

- Modify `src/shared/backup.ts` — v1/v2 manifest parser, normalized `BackupManifest`, `BackupKind`, and export input.
- Modify `src/shared/backup.test.ts` — manifest compatibility and export-input tests.
- Modify `src/shared/ipc.ts` — make `backup:export` consume `{ kind }`.
- Modify `src/main/backup/manifest.ts` / `.test.ts` — build a deterministic v2 manifest from injected kind/time.
- Modify `src/main/backup/archive.ts` / `.test.ts` — write `books/` only for full packages.
- Create `src/main/backup/filename.ts` / `.test.ts` — pure Temporal-based timestamp and default filename formatting.
- Modify `src/main/backup/backup-service.ts` / `.test.ts` — propagate kind, normalize inspect, quick-check staged DB, and branch full-only file validation.
- Modify `src/main/backup/restore.ts` / `.test.ts` — explicit kind-aware file swap and SQLite quick check.
- Modify `src/main/ipc/backup-handlers.ts` — accept export kind, inject Temporal time, select default filename, and relay normalized restore kind.
- Modify `src/preload-api.ts` — update backup API comments; type shape flows from the contract.
- Create `src/renderer/components/ui/dropdown-menu.tsx` — minimal Base UI menu wrapper matching existing UI primitives.
- Create `src/renderer/settings/BackupExportButton.tsx` / `.test.ts` — accessible split button with compact primary and full dropdown action.
- Modify `src/renderer/settings/AdvancedSettings.tsx` — kind-aware export and restore confirmation.
- Modify `src/shared/i18n/locales/en.ts`, `src/shared/i18n/locales/zh-CN.ts` — extracted and translated compact/full copy.
- Create `.changeset/calm-books-travel.md` — user-facing minor changeset.

### Task 1: Versioned manifest and compact archive export

**Files:**

- Modify: `src/shared/backup.ts`
- Modify: `src/shared/backup.test.ts`
- Modify: `src/shared/ipc.ts`
- Modify: `src/main/backup/manifest.ts`
- Modify: `src/main/backup/manifest.test.ts`
- Modify: `src/main/backup/archive.ts`
- Modify: `src/main/backup/archive.test.ts`
- Create: `src/main/backup/filename.ts`
- Create: `src/main/backup/filename.test.ts`
- Modify: `src/main/backup/backup-service.ts`
- Modify: `src/main/backup/backup-service.test.ts`
- Modify: `src/main/ipc/backup-handlers.ts`
- Modify: `src/preload-api.ts`
- Modify: `src/renderer/settings/AdvancedSettings.tsx` (temporary explicit full export until Task 3 installs the split button)

**Interfaces:**

- Produces: `BackupKind = "full" | "compact"`.
- Produces: normalized `backupManifestSchema.parse(raw): BackupManifest`, where v1 gains `kind: "full"` and v2 retains its explicit kind.
- Produces: `backupExportInput` with `{ kind: BackupKind }`.
- Produces: `buildManifest(db, { kind, appVersion, schemaHead, dbSha256, createdAt })`.
- Produces: `createBackupZip(opts)` as a discriminated union requiring `booksDir` only for full packages.
- Produces: `formatBackupTimestamp(now)` and `backupFileName(kind, now)`.
- Produces: `exportBackup(opts)` requiring `kind` and `createdAt`.
- Consumed later by Task 2 restore and Task 3 renderer UI.

- [ ] **Step 1: Replace the shared tests with explicit v1/v2 and export-input cases**

Update `src/shared/backup.test.ts` so the test data and assertions are exact:

```ts
import { describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT_VERSION,
  backupExportInput,
  backupManifestSchema,
} from "@shared/backup";

const common = {
  appVersion: "0.9.0",
  schemaHead: "0007_thing",
  createdAt: 1_700_000_000_000,
  bookCount: 3,
  includesApiKeys: true,
  dbSha256: "deadbeef",
};

describe("backupManifestSchema", () => {
  it.each(["full", "compact"] as const)("accepts a v2 %s manifest", (kind) => {
    const raw = { formatVersion: BACKUP_FORMAT_VERSION, kind, ...common };
    expect(backupManifestSchema.parse(raw)).toEqual(raw);
  });

  it("normalizes a legacy v1 manifest to full", () => {
    expect(backupManifestSchema.parse({ formatVersion: 1, ...common })).toEqual({
      formatVersion: 1,
      kind: "full",
      ...common,
    });
  });

  it("rejects a future format version", () => {
    expect(
      backupManifestSchema.safeParse({
        formatVersion: BACKUP_FORMAT_VERSION + 1,
        kind: "compact",
        ...common,
      }).success,
    ).toBe(false);
  });

  it("rejects v2 without kind and an invalid kind", () => {
    expect(
      backupManifestSchema.safeParse({ formatVersion: BACKUP_FORMAT_VERSION, ...common }).success,
    ).toBe(false);
    expect(
      backupManifestSchema.safeParse({
        formatVersion: BACKUP_FORMAT_VERSION,
        kind: "merged",
        ...common,
      }).success,
    ).toBe(false);
  });

  it("rejects a manifest missing a required checksum", () => {
    const { dbSha256: _dbSha256, ...withoutChecksum } = common;
    expect(
      backupManifestSchema.safeParse({
        formatVersion: BACKUP_FORMAT_VERSION,
        kind: "compact",
        ...withoutChecksum,
      }).success,
    ).toBe(false);
  });
});

describe("backupExportInput", () => {
  it("accepts only an explicit full or compact kind", () => {
    expect(backupExportInput.parse({ kind: "compact" })).toEqual({ kind: "compact" });
    expect(backupExportInput.parse({ kind: "full" })).toEqual({ kind: "full" });
    expect(backupExportInput.safeParse({}).success).toBe(false);
  });
});
```

- [ ] **Step 2: Run the shared test and confirm the red state**

Run: `pnpm test src/shared/backup.test.ts`

Expected: FAIL because `backupExportInput` does not exist and the current manifest is format v1 without `kind`.

- [ ] **Step 3: Implement the normalized manifest and IPC input**

Replace the manifest portion of `src/shared/backup.ts` with:

```ts
import { z } from "zod";

export const BACKUP_FORMAT_VERSION = 2;
export const backupKindSchema = z.enum(["full", "compact"]);
export type BackupKind = z.infer<typeof backupKindSchema>;

const manifestFields = {
  appVersion: z.string(),
  schemaHead: z.string(),
  createdAt: z.number().int().nonnegative(),
  bookCount: z.number().int().nonnegative(),
  includesApiKeys: z.boolean(),
  dbSha256: z.string(),
};

const legacyManifestSchema = z
  .object({ formatVersion: z.literal(1), ...manifestFields })
  .transform((manifest) => ({ ...manifest, kind: "full" as const }));

const currentManifestSchema = z.object({
  formatVersion: z.literal(BACKUP_FORMAT_VERSION),
  kind: backupKindSchema,
  ...manifestFields,
});

export const backupManifestSchema = z.union([legacyManifestSchema, currentManifestSchema]);
export type BackupManifest = z.infer<typeof backupManifestSchema>;

export const backupExportInput = z.object({ kind: backupKindSchema });
export type BackupExportInput = z.infer<typeof backupExportInput>;
```

The remainder of `src/shared/backup.ts` must be exactly:

```ts
export const backupRestoreInput = z.object({ path: z.string().min(1) });
export type BackupRestoreInput = z.infer<typeof backupRestoreInput>;

export interface BackupInspection {
  path: string;
  manifest: BackupManifest;
  compatible: boolean;
  reason?: string;
}

export interface BackupExportResult {
  path: string;
}
```

In `src/shared/ipc.ts`, import `backupExportInput` and change only this contract:

```ts
backupExport: def(
  "backup:export",
  "invoke",
  backupExportInput,
  out<BackupExportResult | null>(),
),
```

- [ ] **Step 4: Add failing manifest-builder tests for kind and injected time**

Update the primary test in `src/main/backup/manifest.test.ts`:

```ts
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
```

Update the empty-library call to pass `kind: "full"` and `createdAt: 1`.

- [ ] **Step 5: Implement deterministic v2 manifest construction**

Change `buildManifest` in `src/main/backup/manifest.ts` to:

```ts
export function buildManifest(
  db: DB,
  opts: {
    kind: BackupKind;
    appVersion: string;
    schemaHead: string;
    dbSha256: string;
    createdAt: number;
  },
): BackupManifest {
  const [{ c }] = db.select({ c: count() }).from(books).all();
  return {
    formatVersion: BACKUP_FORMAT_VERSION,
    kind: opts.kind,
    appVersion: opts.appVersion,
    schemaHead: opts.schemaHead,
    createdAt: opts.createdAt,
    bookCount: c,
    includesApiKeys: true,
    dbSha256: opts.dbSha256,
  };
}
```

Import `BackupKind` beside `BackupManifest`. This removes `Date.now()` from the pure builder.

- [ ] **Step 6: Add failing archive tests proving compact excludes books**

In `src/main/backup/archive.test.ts`, add `kind: "full"` to both existing `createBackupZip` calls, then add:

```ts
it("compact zip contains the database and manifest but no books", async () => {
  const src = tmp("arch-compact-");
  const snapshot = path.join(src, "snap.db");
  writeFileSync(snapshot, "DBDATA");
  const booksDir = path.join(src, "books");
  mkdirSync(booksDir);
  writeFileSync(path.join(booksDir, "a.epub"), "BOOK-A");
  const zipPath = path.join(src, "compact.zip");

  await createBackupZip({
    kind: "compact",
    zipPath,
    snapshotPath: snapshot,
    manifest: { kind: "compact" },
  });

  const dest = tmp("arch-compact-dest-");
  await extractZip(zipPath, dest);
  expect(readFileSync(path.join(dest, "marginalia.db"), "utf8")).toBe("DBDATA");
  expect(existsSync(path.join(dest, "manifest.json"))).toBe(true);
  expect(existsSync(path.join(dest, "books"))).toBe(false);
});
```

- [ ] **Step 7: Make archive inclusion a discriminated union**

In `src/main/backup/archive.ts`, define and use:

```ts
type CreateBackupZipOptions = {
  zipPath: string;
  snapshotPath: string;
  manifest: unknown;
} & ({ kind: "full"; booksDir: string } | { kind: "compact" });

export function createBackupZip(opts: CreateBackupZipOptions): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = createWriteStream(opts.zipPath);
    const archive = new ZipArchive({ zlib: { level: 9 } });
    output.on("close", () => resolve());
    output.on("error", reject);
    archive.on("warning", (e) => log.warn("archive warning", e));
    archive.on("error", reject);
    archive.pipe(output);
    archive.file(opts.snapshotPath, { name: "marginalia.db" });
    if (opts.kind === "full" && existsSync(opts.booksDir)) {
      archive.directory(opts.booksDir, "books");
    }
    archive.append(JSON.stringify(opts.manifest, null, 2), { name: "manifest.json" });
    void archive.finalize();
  });
}
```

Do not make `booksDir` optional: compact/full behavior must stay type-driven.

- [ ] **Step 8: Add failing pure filename tests**

Create `src/main/backup/filename.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { backupFileName, formatBackupTimestamp } from "@main/backup/filename";

const NOW = Temporal.ZonedDateTime.from("2026-07-14T09:08:07+08:00[Asia/Singapore]");

describe("backup filenames", () => {
  it("formats a stable local timestamp", () => {
    expect(formatBackupTimestamp(NOW)).toBe("20260714-090807");
  });

  it("distinguishes compact and full exports", () => {
    expect(backupFileName("compact", NOW)).toBe(
      "marginalia-compact-backup-20260714-090807.zip",
    );
    expect(backupFileName("full", NOW)).toBe("marginalia-backup-20260714-090807.zip");
  });
});
```

- [ ] **Step 9: Implement the pure Temporal filename helper**

Create `src/main/backup/filename.ts`:

```ts
import type { BackupKind } from "@shared/backup";

const two = (value: number): string => String(value).padStart(2, "0");

export function formatBackupTimestamp(now: Temporal.ZonedDateTime): string {
  return `${now.year}${two(now.month)}${two(now.day)}-${two(now.hour)}${two(now.minute)}${two(now.second)}`;
}

export function backupFileName(kind: BackupKind, now: Temporal.ZonedDateTime): string {
  const prefix = kind === "compact" ? "marginalia-compact-backup" : "marginalia-backup";
  return `${prefix}-${formatBackupTimestamp(now)}.zip`;
}
```

- [ ] **Step 10: Propagate kind/time through export service and Electron glue**

In `src/main/backup/backup-service.ts`, extend export options with `kind: BackupKind` and `createdAt: number`, use `export-${opts.createdAt}.db`, pass both to `buildManifest`, and call the archive with an explicit union branch:

```ts
const archiveBase = {
  zipPath: opts.zipPath,
  snapshotPath,
  manifest,
};
await createBackupZip(
  opts.kind === "full"
    ? { ...archiveBase, kind: "full", booksDir: opts.booksDir }
    : { ...archiveBase, kind: "compact" },
);
```

In `src/main/ipc/backup-handlers.ts`, delete the Date-based `timestamp()` function. The export handler becomes:

```ts
bind(C.backupExport, async (input) => {
  const win = BrowserWindow.getFocusedWindow();
  const now = Temporal.Now.zonedDateTimeISO();
  const opts = {
    defaultPath: backupFileName(input.kind, now),
    filters: [{ name: "Marginalia Backup", extensions: ["zip"] }],
  };
  const r = win ? await dialog.showSaveDialog(win, opts) : await dialog.showSaveDialog(opts);
  if (r.canceled || !r.filePath) return null;
  const folder = resolveMigrationsFolder();
  const res = await exportBackup({
    kind: input.kind,
    createdAt: now.epochMilliseconds,
    db: getDb(),
    rawSqlite: getDb().$client,
    zipPath: r.filePath,
    booksDir: appService.getPath("booksDir"),
    tmpDir: appService.getPath("tmpDir"),
    appVersion: app.getVersion(),
    schemaHead: latestMigrationDir(folder),
  });
  log.info(`${input.kind} backup exported to ${res.path}`);
  return res;
}),
```

Import `backupFileName` and `formatBackupTimestamp`; use `formatBackupTimestamp(Temporal.Now.zonedDateTimeISO())` for the existing restore stamp. Update the preload comment to state that export requires an explicit kind; no handwritten type is needed because `inv(C.backupExport)` flows from Zod.

To keep the tree compiling before Task 3 changes the UI, update the existing call in `AdvancedSettings.tsx` to `window.api.backup.export({ kind: "full" })`; leave its current button and copy intact for this task.

- [ ] **Step 11: Update service tests for explicit full/compact exports**

In `src/main/backup/backup-service.test.ts`, make every existing `exportBackup` call explicit with `kind: "full"` and `createdAt: 1`. Add `kind: "full"` to the existing direct `createBackupZip` corrupt-fixture call; keep that fixture's v1 manifest shape for the legacy parser path. Extend the first export assertion with:

```ts
expect(ins.manifest.kind).toBe("full");
expect(ins.manifest.formatVersion).toBe(2);
```

Add this compact export case:

```ts
it("exports a compact zip without books", async () => {
  await exportBackup({
    kind: "compact",
    createdAt: 2,
    db: src.db,
    rawSqlite: src.db.$client,
    zipPath,
    booksDir: src.booksDir,
    tmpDir: src.tmpDir,
    appVersion: "9.9.9",
    schemaHead: HEAD,
  });

  const extracted = tmp("svc-compact-extract-");
  await extractZip(zipPath, extracted);
  expect(existsSync(path.join(extracted, "marginalia.db"))).toBe(true);
  expect(existsSync(path.join(extracted, "books"))).toBe(false);
  const inspection = await inspectBackup({ zipPath, knownMigrationDirs: KNOWN });
  expect(inspection.manifest.kind).toBe("compact");
});
```

Import `extractZip` beside `createBackupZip`.

- [ ] **Step 12: Run focused tests and typecheck**

Run:

```bash
pnpm test src/shared/backup.test.ts src/main/backup/manifest.test.ts src/main/backup/archive.test.ts src/main/backup/filename.test.ts src/main/backup/backup-service.test.ts
pnpm typecheck
```

Expected: all listed tests PASS and TypeScript reports no errors.

- [ ] **Step 13: Commit the versioned compact export**

```bash
git add src/shared/backup.ts src/shared/backup.test.ts src/shared/ipc.ts \
  src/main/backup/manifest.ts src/main/backup/manifest.test.ts \
  src/main/backup/archive.ts src/main/backup/archive.test.ts \
  src/main/backup/filename.ts src/main/backup/filename.test.ts \
  src/main/backup/backup-service.ts src/main/backup/backup-service.test.ts \
  src/main/ipc/backup-handlers.ts src/preload-api.ts \
  src/renderer/settings/AdvancedSettings.tsx
git commit -m "feat(backup): add compact archive export"
```

### Task 2: Kind-aware snapshot restore

**Files:**

- Modify: `src/main/backup/restore.ts`
- Modify: `src/main/backup/restore.test.ts`
- Modify: `src/main/backup/backup-service.ts`
- Modify: `src/main/backup/backup-service.test.ts`

**Interfaces:**

- Consumes: normalized `BackupManifest.kind` from Task 1.
- Produces: `verifySqliteDatabase(dbFile): void` using `PRAGMA quick_check`.
- Produces: `applyRestore({ kind, dataDir, booksDir, stagingDir, preRestoreTarget, dbFileName })`.
- Produces: `restoreBackup` that always verifies DB integrity, runs `verifyBookFiles` only for full, and passes manifest kind into the swap.

- [ ] **Step 1: Add failing quick-check and compact-swap tests**

In `src/main/backup/restore.test.ts`, import `verifySqliteDatabase`. Keep the existing full swap test but pass `kind: "full"`. Add:

```ts
it("quick-check accepts SQLite and rejects a non-database file", () => {
  const dir = tmp("quick-check-");
  const dbFile = path.join(dir, "ok.db");
  seedDb(dbFile, []);
  expect(() => verifySqliteDatabase(dbFile)).not.toThrow();
  const badFile = path.join(dir, "bad.db");
  writeFileSync(badFile, "not sqlite");
  expect(() => verifySqliteDatabase(badFile)).toThrow(/integrity check/i);
});

it("compact restore replaces only DB files and preserves books in place", async () => {
  const dataDir = tmp("ar-compact-data-");
  const booksDir = path.join(dataDir, "books");
  mkdirSync(booksDir);
  writeFileSync(path.join(dataDir, "marginalia.db"), "OLD-DB");
  writeFileSync(path.join(dataDir, "marginalia.db-wal"), "OLD-WAL");
  writeFileSync(path.join(booksDir, "keep.epub"), "KEEP-BOOK");

  const stagingDir = tmp("ar-compact-stage-");
  writeFileSync(path.join(stagingDir, "marginalia.db"), "NEW-DB");
  const preRestoreTarget = path.join(tmp("ar-compact-pre-"), "snap");

  await applyRestore({
    kind: "compact",
    dataDir,
    booksDir,
    stagingDir,
    preRestoreTarget,
    dbFileName: "marginalia.db",
  });

  expect(readFileSync(path.join(dataDir, "marginalia.db"), "utf8")).toBe("NEW-DB");
  expect(readFileSync(path.join(booksDir, "keep.epub"), "utf8")).toBe("KEEP-BOOK");
  expect(readFileSync(path.join(preRestoreTarget, "marginalia.db"), "utf8")).toBe("OLD-DB");
  expect(readFileSync(path.join(preRestoreTarget, "marginalia.db-wal"), "utf8")).toBe(
    "OLD-WAL",
  );
  expect(existsSync(path.join(preRestoreTarget, "books"))).toBe(false);
});
```

- [ ] **Step 2: Run the restore test and confirm the red state**

Run: `pnpm test src/main/backup/restore.test.ts`

Expected: FAIL because `verifySqliteDatabase` and the `kind` option do not exist.

- [ ] **Step 3: Implement SQLite quick-check and explicit swap branching**

In `src/main/backup/restore.ts`, add:

```ts
import type { BackupKind } from "@shared/backup";

export function verifySqliteDatabase(dbFile: string): void {
  let sqlite: Database.Database | undefined;
  try {
    sqlite = new Database(dbFile, { readonly: true, fileMustExist: true });
    const result = sqlite.prepare("PRAGMA quick_check").pluck().all() as string[];
    if (result.length !== 1 || result[0] !== "ok") {
      throw new Error(`database integrity check failed: ${result.join(", ")}`);
    }
  } catch (err) {
    if (err instanceof Error && /integrity check/.test(err.message)) throw err;
    throw new Error("database integrity check failed", { cause: err });
  } finally {
    sqlite?.close();
  }
}
```

Extend `applyRestore` with `kind: BackupKind`. Keep DB-three-piece movement unconditional, then wrap both books moves:

```ts
if (opts.kind === "full" && existsSync(opts.booksDir)) {
  await rename(opts.booksDir, path.join(opts.preRestoreTarget, "books"));
}

await rename(
  path.join(opts.stagingDir, opts.dbFileName),
  path.join(opts.dataDir, opts.dbFileName),
);

if (opts.kind === "full") {
  const stagedBooks = path.join(opts.stagingDir, "books");
  if (existsSync(stagedBooks)) await rename(stagedBooks, opts.booksDir);
}
```

Update the function comment to state the two exact modes; do not infer mode from staged entries.

- [ ] **Step 4: Add a failing compact service roundtrip**

In `src/main/backup/backup-service.test.ts`, add:

```ts
it("compact restore replaces the DB and preserves all local book files", async () => {
  await exportBackup({
    kind: "compact",
    createdAt: 3,
    db: src.db,
    rawSqlite: src.db.$client,
    zipPath,
    booksDir: src.booksDir,
    tmpDir: src.tmpDir,
    appVersion: "9.9.9",
    schemaHead: HEAD,
  });
  src.db.$client.close();

  const dataDir = tmp("svc-compact-dst-");
  const oldDb = createDb(path.join(dataDir, "marginalia.db"));
  runMigrations(oldDb, MIG);
  oldDb.insert(books).values({ id: "old", format: "epub" }).run();
  oldDb.$client.close();
  const booksDir = path.join(dataDir, "books");
  mkdirSync(booksDir);
  writeFileSync(storedBookPath(booksDir, "b1", "epub"), "LOCAL-B1");
  writeFileSync(storedBookPath(booksDir, "orphan", "epub"), "LOCAL-ORPHAN");
  const preRestoreDir = path.join(dataDir, "pre-restore");
  const stamp = "compact-swap";

  await restoreBackup({
    zipPath,
    dataDir,
    booksDir,
    tmpDir: path.join(dataDir, "tmp"),
    preRestoreDir,
    dbFileName: "marginalia.db",
    knownMigrationDirs: KNOWN,
    stamp,
    closeDb: () => {},
  });

  const restored = createDb(path.join(dataDir, "marginalia.db"));
  runMigrations(restored, MIG);
  expect(restored.select().from(books).all().map((book) => book.id)).toEqual(["b1"]);
  restored.$client.close();
  expect(readFileSync(storedBookPath(booksDir, "b1", "epub"), "utf8")).toBe("LOCAL-B1");
  expect(readFileSync(storedBookPath(booksDir, "orphan", "epub"), "utf8")).toBe(
    "LOCAL-ORPHAN",
  );
  expect(existsSync(path.join(preRestoreDir, stamp, "marginalia.db"))).toBe(true);
  expect(existsSync(path.join(preRestoreDir, stamp, "books"))).toBe(false);
});
```

Add a second compact restore case with an empty target `booksDir`:

```ts
it("compact restore reuses the existing missing-file fallback", async () => {
  await exportBackup({
    kind: "compact",
    createdAt: 4,
    db: src.db,
    rawSqlite: src.db.$client,
    zipPath,
    booksDir: src.booksDir,
    tmpDir: src.tmpDir,
    appVersion: "9.9.9",
    schemaHead: HEAD,
  });
  src.db.$client.close();

  const dataDir = tmp("svc-compact-missing-");
  const oldDb = createDb(path.join(dataDir, "marginalia.db"));
  runMigrations(oldDb, MIG);
  oldDb.$client.close();
  const booksDir = path.join(dataDir, "books");
  mkdirSync(booksDir);

  await restoreBackup({
    zipPath,
    dataDir,
    booksDir,
    tmpDir: path.join(dataDir, "tmp"),
    preRestoreDir: path.join(dataDir, "pre-restore"),
    dbFileName: "marginalia.db",
    knownMigrationDirs: KNOWN,
    stamp: "compact-missing",
    closeDb: () => {},
  });

const restored = createDb(path.join(dataDir, "marginalia.db"));
runMigrations(restored, MIG);
expect(restored.select().from(books).all().map((book) => book.id)).toContain("b1");
restored.$client.close();
await expect(readBookFileResult(booksDir, "b1", "epub")).resolves.toEqual({
  ok: false,
  error: { reason: "missing" },
});
});
```

Import `readBookFileResult` beside `storedBookPath`.

- [ ] **Step 5: Make restore service branch only on normalized manifest kind**

In `restoreBackup`:

```ts
verifySqliteDatabase(stagedDb);

if (manifest.kind === "full") {
  const bookCheck = verifyBookFiles(stagedDb, stagedBooks);
  if (!bookCheck.ok) {
    throw new Error(
      `restore refused: backup is missing book files: ${bookCheck.missing.join(", ")}`,
    );
  }
}

// after closeDb()
await applyRestore({
  kind: manifest.kind,
  dataDir: opts.dataDir,
  booksDir: opts.booksDir,
  stagingDir,
  preRestoreTarget,
  dbFileName: opts.dbFileName,
});
```

Make the mid-swap recovery message kind-aware:

```ts
const preserved =
  manifest.kind === "full"
    ? "marginalia.db and the books folder"
    : "marginalia.db";
throw new Error(
  `Restore failed while swapping files. Your original ${preserved} is preserved at ${preRestoreTarget}.`,
);
```

- [ ] **Step 6: Update corrupt-bundle fixtures to v2 and preserve a v1 regression**

Change the corrupt compact fixture to include `formatVersion: 2, kind: "compact"`. Add an inspect assertion using the old v1 manifest shape and expect `manifest.kind === "full"`; this is the service-level legacy regression beyond the shared parser test.

- [ ] **Step 7: Run focused restore tests and typecheck**

Run:

```bash
pnpm test src/main/backup/restore.test.ts src/main/backup/backup-service.test.ts
pnpm typecheck
```

Expected: all restore/service tests PASS and TypeScript reports no errors.

- [ ] **Step 8: Commit kind-aware restore**

```bash
git add src/main/backup/restore.ts src/main/backup/restore.test.ts \
  src/main/backup/backup-service.ts src/main/backup/backup-service.test.ts
git commit -m "feat(backup): preserve book files on compact restore"
```

### Task 3: Split-button UI and kind-specific restore confirmation

**Files:**

- Create: `src/renderer/components/ui/dropdown-menu.tsx`
- Create: `src/renderer/settings/BackupExportButton.tsx`
- Create: `src/renderer/settings/BackupExportButton.test.ts`
- Modify: `src/renderer/settings/AdvancedSettings.tsx`
- Modify: `src/shared/i18n/locales/en.ts`
- Modify: `src/shared/i18n/locales/zh-CN.ts`

**Interfaces:**

- Consumes: `BackupKind` and `window.api.backup.export({ kind })` from Task 1.
- Consumes: normalized `pendingRestore.manifest.kind` from Task 1/2.
- Produces: `BackupExportButton({ disabled, onExport })`, where main action emits `compact` and dropdown item emits `full`.
- Produces: full/compact-specific destructive confirmation text while keeping one restore entry point.

Before editing the UI primitive in this task, invoke the repository's `shadcn` skill because `components.json` is present. Keep the approved split-button shape and Base UI semantics even if the skill recommends a registry command for the wrapper.

- [ ] **Step 1: Add a focused happy-dom interaction test for the split button**

Create `src/renderer/settings/BackupExportButton.test.ts`:

```ts
/* @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BackupExportButton } from "@renderer/settings/BackupExportButton";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (_key: string, fallback: string) => fallback }),
}));

if (!globalThis.PointerEvent) {
  Object.defineProperty(globalThis, "PointerEvent", { value: MouseEvent });
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("BackupExportButton", () => {
  it("uses compact for the main action", () => {
    const onExport = vi.fn();
    act(() => root.render(createElement(BackupExportButton, { disabled: false, onExport })));
    const main = host.querySelector<HTMLButtonElement>('[data-slot="backup-export-compact"]')!;
    act(() => main.click());
    expect(onExport).toHaveBeenCalledWith("compact");
  });

  it("uses full for the dropdown item", async () => {
    const onExport = vi.fn();
    act(() => root.render(createElement(BackupExportButton, { disabled: false, onExport })));
    const trigger = host.querySelector<HTMLButtonElement>('[data-slot="backup-export-menu"]')!;
    await act(async () => trigger.click());
    const full = document.body.querySelector<HTMLElement>('[data-slot="backup-export-full"]')!;
    await act(async () => full.click());
    expect(onExport).toHaveBeenCalledWith("full");
  });
});
```

- [ ] **Step 2: Run the component test and confirm the red state**

Run: `pnpm test src/renderer/settings/BackupExportButton.test.ts`

Expected: FAIL because `BackupExportButton` does not exist.

- [ ] **Step 3: Add the minimal Base UI dropdown wrapper**

Create `src/renderer/components/ui/dropdown-menu.tsx` following the existing `context-menu.tsx` geometry, but with `Menu`:

```tsx
"use client";

import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { cn } from "@renderer/lib/utils";

const DropdownMenu = MenuPrimitive.Root;

function DropdownMenuTrigger(props: MenuPrimitive.Trigger.Props) {
  return <MenuPrimitive.Trigger data-slot="dropdown-menu-trigger" {...props} />;
}

function DropdownMenuContent({
  className,
  align = "end",
  side = "bottom",
  sideOffset = 4,
  ...props
}: MenuPrimitive.Popup.Props &
  Pick<MenuPrimitive.Positioner.Props, "align" | "side" | "sideOffset">) {
  return (
    <MenuPrimitive.Portal>
      <MenuPrimitive.Positioner
        align={align}
        side={side}
        sideOffset={sideOffset}
        className="isolate z-50 outline-none"
      >
        <MenuPrimitive.Popup
          data-slot="dropdown-menu-content"
          className={cn(
            "z-50 min-w-52 origin-(--transform-origin) rounded-md bg-popover p-1 text-sm text-popover-foreground shadow-md ring-1 ring-foreground/10 outline-hidden duration-100 data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95",
            className,
          )}
          {...props}
        />
      </MenuPrimitive.Positioner>
    </MenuPrimitive.Portal>
  );
}

function DropdownMenuItem({ className, ...props }: MenuPrimitive.Item.Props) {
  return (
    <MenuPrimitive.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "flex w-full cursor-default items-start gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-disabled:pointer-events-none data-disabled:opacity-50 [&_svg]:mt-0.5 [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    />
  );
}

export { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger };
```

- [ ] **Step 4: Implement the selected split-button design**

Create `src/renderer/settings/BackupExportButton.tsx`:

```tsx
import { Archive, ChevronDown, Download } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { BackupKind } from "@shared/backup";
import { Button } from "@renderer/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@renderer/components/ui/dropdown-menu";

interface Props {
  disabled: boolean;
  onExport: (kind: BackupKind) => void;
}

export function BackupExportButton({ disabled, onExport }: Props) {
  const { t } = useTranslation();
  return (
    <div className="inline-flex">
      <Button
        data-slot="backup-export-compact"
        variant="outline"
        size="sm"
        className="rounded-r-none border-r-0"
        disabled={disabled}
        onClick={() => onExport("compact")}
      >
        <Download />
        {t("settings.backup.exportCompact", "导出精简备份")}
      </Button>
      <DropdownMenu>
        <DropdownMenuTrigger
          data-slot="backup-export-menu"
          render={
            <Button
              variant="outline"
              size="icon-sm"
              className="rounded-l-none px-1.5"
              disabled={disabled}
              aria-label={t("settings.backup.exportOptions", "选择备份类型")}
            />
          }
        >
          <ChevronDown />
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            data-slot="backup-export-full"
            onClick={() => onExport("full")}
          >
            <Archive />
            <span>
              <span className="block font-medium">
                {t("settings.backup.exportFull", "导出完整备份")}
              </span>
              <span className="block text-xs text-muted-foreground">
                {t("settings.backup.exportFullDesc", "包含所有 EPUB / PDF 原文件")}
              </span>
            </span>
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
```

- [ ] **Step 5: Wire kind-aware export into AdvancedSettings**

Change `onExport` to:

```ts
const onExport = async (kind: BackupKind) => {
  setBusy(true);
  try {
    const res = await window.api.backup.export({ kind });
    if (res) {
      toast.success(t("settings.backup.exportDone", "备份已导出：{{path}}", { path: res.path }));
    }
  } catch {
    toast.error(t("settings.backup.exportFailed", "备份导出失败"));
  } finally {
    setBusy(false);
  }
};
```

Import `BackupKind` and `BackupExportButton`. Replace the old export `<Button>` with:

```tsx
<BackupExportButton disabled={busy} onExport={(kind) => void onExport(kind)} />
```

Keep the single restore button adjacent.

- [ ] **Step 6: Make restore confirmation copy branch by manifest kind**

Replace the current `new Date(...).toLocaleString()` expression with Temporal:

```ts
const backupWhen = pendingRestore
  ? Temporal.Instant.fromEpochMilliseconds(pendingRestore.manifest.createdAt).toLocaleString()
  : "";
```

In the dialog description, branch explicitly:

```tsx
{pendingRestore
  ? pendingRestore.manifest.kind === "compact"
    ? t(
        "settings.backup.confirmCompactRestore",
        "将用此精简备份整体替换当前应用数据（{{count}} 本书，导出于 {{when}}）。本机现有书籍原文件不会被删除或覆盖；缺少本地文件的书可在恢复后重新连接。当前数据库会先保留安全副本，随后应用将重启。",
        { count: pendingRestore.manifest.bookCount, when: backupWhen },
      )
    : t(
        "settings.backup.confirmFullRestore",
        "将用此完整备份整体替换当前全部数据与书籍原文件（{{count}} 本书，导出于 {{when}}）。替换前会自动保留一份当前数据的备份，随后应用将重启。",
        { count: pendingRestore.manifest.bookCount, when: backupWhen },
      )
  : ""}
```

Make the dialog title include the normalized type label exactly:

```tsx
<AlertDialogTitle>
  {pendingRestore?.manifest.kind === "compact"
    ? t("settings.backup.kindCompact", "精简备份")
    : t("settings.backup.kindFull", "完整备份")}
  {` · ${t("settings.backup.restoreTitle", "还原备份？")}`}
</AlertDialogTitle>
```

Do not use merge/sync/LWW wording.

- [ ] **Step 7: Update explanatory copy and run i18n extraction**

Update the settings paragraph default to:

```tsx
t(
  "settings.backup.warning",
  "精简备份包含全部应用数据但不含书籍原文件，适合在设备间传递；完整备份额外包含所有 EPUB / PDF。两种备份都含明文 API key，请妥善保管。",
)
```

Run: `pnpm i18n:extract`

Expected: the new keys appear in both locale files and obsolete `settings.backup.export` / `confirmRestore` keys are removed if no longer referenced.

Fill English translations exactly as follows (with i18next-generated `_one` / `_other` plural variants where it creates them):

```text
exportCompact: Export Compact Backup
exportOptions: Choose backup type
exportFull: Export Full Backup
exportFullDesc: Includes every original EPUB / PDF file
kindCompact: Compact backup
kindFull: Full backup
warning: Compact backups include all app data but omit original book files, making them easier to move between devices. Full backups also include every EPUB / PDF. Both contain plaintext API keys — keep them private.
```

Translate both confirmation variants faithfully to the Chinese defaults above; English compact copy must explicitly say local original book files are kept, while English full copy must explicitly say they are replaced.

- [ ] **Step 8: Run UI, i18n, and type verification**

Run:

```bash
pnpm test src/renderer/settings/BackupExportButton.test.ts
pnpm i18n:lint
pnpm typecheck
pnpm lint
pnpm format:check
```

Expected: component test PASS; i18n reports no missing keys; typecheck/lint/format all exit 0.

- [ ] **Step 9: Commit the split-button UI**

```bash
git add src/renderer/components/ui/dropdown-menu.tsx \
  src/renderer/settings/BackupExportButton.tsx \
  src/renderer/settings/BackupExportButton.test.ts \
  src/renderer/settings/AdvancedSettings.tsx \
  src/shared/i18n/locales/en.ts src/shared/i18n/locales/zh-CN.ts
git commit -m "feat(settings): add compact backup split button"
```

### Task 4: Full regression, packaged behavior guard, and changelog

**Files:**

- Create: `.changeset/calm-books-travel.md`

**Interfaces:**

- Consumes: complete compact/full export and restore flows from Tasks 1–3.
- Produces: a verified, user-visible feature ready for branch finishing and issue closure.

- [ ] **Step 1: Run the complete backup test slice**

Run:

```bash
pnpm test src/shared/backup.test.ts \
  src/main/backup/manifest.test.ts \
  src/main/backup/archive.test.ts \
  src/main/backup/filename.test.ts \
  src/main/backup/compat.test.ts \
  src/main/backup/restore.test.ts \
  src/main/backup/backup-service.test.ts \
  src/renderer/settings/BackupExportButton.test.ts \
  src/main/ipc/bindings-coverage.test.ts \
  src/preload-api.test.ts
```

Expected: all listed test files PASS, including legacy v1 full restore, v2 full restore, compact DB-only restore, IPC coverage, and preload coverage.

- [ ] **Step 2: Run all repository checks**

Run:

```bash
pnpm test
pnpm typecheck
pnpm lint
pnpm format:check
pnpm i18n:lint
```

Expected: every command exits 0. If `pnpm format:check` fails, run `pnpm format`, inspect only formatter-owned diffs, and repeat the full check set.

- [ ] **Step 3: Build the packaged app**

Run: `pnpm package`

Expected: Electron Forge finishes successfully and creates the packaged app under `out/` without missing-module or native ABI errors.

- [ ] **Step 4: Add the user-facing changeset**

Create `.changeset/calm-books-travel.md`:

```md
---
"marginalia": minor
---

Add compact backups that keep all app data while omitting heavyweight original book files, with database-only restore that preserves local book files.
```

- [ ] **Step 5: Verify the final diff is scoped to #104**

Run:

```bash
git status --short
git diff --check
git diff --stat main...HEAD
```

Expected: only the spec/plan, backup protocol/service/restore, backup settings UI/i18n, tests, and one changeset are present; no migration, dependency, lockfile, or book-file storage changes.

- [ ] **Step 6: Commit the changeset and mark the issue for closure**

```bash
git add .changeset/calm-books-travel.md
git commit -m "chore: add compact backup changeset" -m "closes #104"
```

- [ ] **Step 7: Hand off to branch-finishing review**

Invoke `verification-before-completion`, then `requesting-code-review`, then `finishing-a-development-branch`. Do not move issue #104 to Done until the implementation is integrated; keep it In progress or move it to In review according to the chosen handoff.
