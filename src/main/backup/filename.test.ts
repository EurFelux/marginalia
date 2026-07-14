import { describe, expect, it } from "vitest";
import { backupFileName, formatBackupTimestamp } from "@main/backup/filename";

const NOW = Temporal.ZonedDateTime.from("2026-07-14T09:08:07+08:00[Asia/Singapore]");

describe("backup filenames", () => {
  it("formats a stable local timestamp", () => {
    expect(formatBackupTimestamp(NOW)).toBe("20260714-090807");
  });

  it("distinguishes compact and full exports", () => {
    expect(backupFileName("compact", NOW)).toBe("marginalia-compact-backup-20260714-090807.zip");
    expect(backupFileName("full", NOW)).toBe("marginalia-backup-20260714-090807.zip");
  });
});
