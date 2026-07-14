import type { BackupKind } from "@shared/backup";

const two = (value: number): string => String(value).padStart(2, "0");

export function formatBackupTimestamp(now: Temporal.ZonedDateTime): string {
  return `${now.year}${two(now.month)}${two(now.day)}-${two(now.hour)}${two(now.minute)}${two(now.second)}`;
}

export function backupFileName(kind: BackupKind, now: Temporal.ZonedDateTime): string {
  const prefix = kind === "compact" ? "marginalia-compact-backup" : "marginalia-backup";
  return `${prefix}-${formatBackupTimestamp(now)}.zip`;
}
