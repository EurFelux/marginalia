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
    const { dbSha256: _dbSha256, ...partial } = valid;
    expect(backupManifestSchema.safeParse(partial).success).toBe(false);
  });

  it("rejects a wrong type", () => {
    expect(backupManifestSchema.safeParse({ ...valid, bookCount: "3" }).success).toBe(false);
  });
});
