import { describe, expect, it } from "vitest";
import {
  BACKUP_FORMAT_VERSION,
  backupExportInput,
  backupManifestSchema,
  backupRestoreInput,
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

describe("backupRestoreInput", () => {
  it("requires the archive checksum returned by inspection", () => {
    const archiveSha256 = "a".repeat(64);
    expect(backupRestoreInput.parse({ path: "/tmp/backup.zip", archiveSha256 })).toEqual({
      path: "/tmp/backup.zip",
      archiveSha256,
    });
    expect(backupRestoreInput.safeParse({ path: "/tmp/backup.zip" }).success).toBe(false);
  });
});
