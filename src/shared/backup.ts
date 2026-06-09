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
