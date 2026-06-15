import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { blob } from "@main/db/schema";
import { getPreference } from "@main/preferences/repository";
import { storeAvatar, resetAvatar, AVATAR_MAX_BYTES } from "@main/ai/agent-avatar";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const TXT = new Uint8Array([0x68, 0x69]); // "hi" — not an image

describe("agent-avatar", () => {
  it("storeAvatar writes a blob, sets avatarBlobId, returns set+id", () => {
    const db = freshDb();
    const r = storeAvatar(db, PNG);
    expect(r.status).toBe("set");
    const id = r.status === "set" ? r.blobId : "";
    expect(getPreference(db, "avatarBlobId")).toBe(id);
    expect(db.select().from(blob).all()).toHaveLength(1);
  });

  it("rejects oversize bytes (too-large), no write", () => {
    const db = freshDb();
    const big = new Uint8Array(AVATAR_MAX_BYTES + 1);
    big.set(PNG, 0);
    expect(storeAvatar(db, big).status).toBe("too-large");
    expect(getPreference(db, "avatarBlobId")).toBeNull();
    expect(db.select().from(blob).all()).toHaveLength(0);
  });

  it("rejects non-image bytes (unsupported), no write", () => {
    const db = freshDb();
    expect(storeAvatar(db, TXT).status).toBe("unsupported");
    expect(db.select().from(blob).all()).toHaveLength(0);
  });

  it("replacing deletes the old blob (no orphan)", () => {
    const db = freshDb();
    const r1 = storeAvatar(db, PNG);
    const r2 = storeAvatar(db, PNG);
    const id2 = r2.status === "set" ? r2.blobId : "";
    const rows = db.select().from(blob).all();
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe(id2);
    expect(getPreference(db, "avatarBlobId")).toBe(id2);
    void r1;
  });

  it("resetAvatar deletes blob and nulls the preference", () => {
    const db = freshDb();
    storeAvatar(db, PNG);
    resetAvatar(db);
    expect(getPreference(db, "avatarBlobId")).toBeNull();
    expect(db.select().from(blob).all()).toHaveLength(0);
  });

  it("resetAvatar is a no-op when nothing set", () => {
    const db = freshDb();
    expect(() => resetAvatar(db)).not.toThrow();
  });
});
