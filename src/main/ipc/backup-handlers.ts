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
import { backupFileName, formatBackupTimestamp } from "@main/backup/filename";
import { createLogger } from "@main/logger";

const log = createLogger("backup");

export const backupBindings: Binding[] = [
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
      stamp: formatBackupTimestamp(Temporal.Now.zonedDateTimeISO()),
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
