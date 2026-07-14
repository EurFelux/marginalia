import { describe, expect, it } from "vitest";

import { restoreConfirmationCopy } from "@renderer/settings/restore-confirmation";

describe("restoreConfirmationCopy", () => {
  it("selects the full-backup confirmation copy", () => {
    expect(restoreConfirmationCopy("full")).toEqual({
      kindKey: "settings.backup.kindFull",
      kind: "完整备份",
      confirmationKey: "settings.backup.confirmFullRestore",
      confirmation:
        "将用此完整备份整体替换当前全部数据与书籍原文件（{{count}} 本书，导出于 {{when}}）。替换前会自动保留一份当前数据的备份，随后应用将重启。",
    });
  });

  it("selects the compact-backup confirmation copy", () => {
    expect(restoreConfirmationCopy("compact")).toEqual({
      kindKey: "settings.backup.kindCompact",
      kind: "精简备份",
      confirmationKey: "settings.backup.confirmCompactRestore",
      confirmation:
        "将用此精简备份整体替换当前应用数据（{{count}} 本书，导出于 {{when}}）。本机现有书籍原文件不会被删除或覆盖；缺少本地文件的书可在恢复后重新连接。当前数据库会先保留安全副本，随后应用将重启。",
    });
  });
});
