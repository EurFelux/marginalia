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

export const backupRestoreInput = z.object({
  path: z.string().min(1),
  archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
});
export type BackupRestoreInput = z.infer<typeof backupRestoreInput>;

export interface BackupInspection {
  path: string;
  /** Whole archive checksum used to bind this inspection to the later destructive restore. */
  archiveSha256: string;
  manifest: BackupManifest;
  compatible: boolean;
  reason?: string;
}

export interface BackupExportResult {
  path: string;
}
