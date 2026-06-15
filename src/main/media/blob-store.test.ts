import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { blob } from "@main/db/schema";
import { writeBlob, deleteBlob, blobResponseFor } from "@main/media/blob-store";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");
function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]); // PNG magic

describe("blob-store", () => {
  it("writeBlob stores bytes + mime and returns an id", () => {
    const db = freshDb();
    const id = writeBlob(db, PNG, "image/png");
    expect(id).toMatch(/[0-9a-f-]{36}/);
    const hit = blobResponseFor(db, id);
    expect(hit).not.toBeNull();
    expect(hit!.contentType).toBe("image/png");
    expect(Array.from(hit!.bytes)).toEqual(Array.from(PNG));
  });

  it("blobResponseFor returns null for unknown id", () => {
    expect(blobResponseFor(freshDb(), "nope")).toBeNull();
  });

  it("deleteBlob removes the row", () => {
    const db = freshDb();
    const id = writeBlob(db, PNG, "image/png");
    deleteBlob(db, id);
    expect(blobResponseFor(db, id)).toBeNull();
    expect(db.select().from(blob).all()).toHaveLength(0);
  });
});
