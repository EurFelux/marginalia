import type { BackupKind } from "@shared/backup";

export function restoreConfirmationCopy(kind: BackupKind) {
  return kind === "compact"
    ? {
        kindKey: "settings.backup.kindCompact",
        kind: "精简备份",
        confirmationKey: "settings.backup.confirmCompactRestore",
        confirmation:
          "将用此精简备份整体替换当前应用数据（{{count}} 本书，导出于 {{when}}）。本机现有书籍原文件不会被删除或覆盖；缺少本地文件的书可在恢复后重新连接。当前数据库会先保留安全副本，随后应用将重启。",
      }
    : {
        kindKey: "settings.backup.kindFull",
        kind: "完整备份",
        confirmationKey: "settings.backup.confirmFullRestore",
        confirmation:
          "将用此完整备份整体替换当前全部数据与书籍原文件（{{count}} 本书，导出于 {{when}}）。替换前会自动保留一份当前数据的备份，随后应用将重启。",
      };
}
