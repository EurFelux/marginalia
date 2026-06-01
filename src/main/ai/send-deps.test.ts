import { describe, expect, it, vi } from "vitest";
import { createLoadBytes } from "@main/ai/send-deps";
import type { DB } from "@main/db/client";

const fakeDb = (_path: string | null) =>
  ({
    /* 仅供 getBook 经由 select().from().where().get() 使用，见下方 mock */
  }) as unknown as DB;

vi.mock("@main/library/repository", () => ({
  getBook: (_db: unknown, id: string) =>
    id === "known" ? { id, path: "/tmp/marginalia-test.epub" } : undefined,
}));

vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => Buffer.from([1, 2, 3])),
}));

describe("createLoadBytes", () => {
  it("reads bytes for a known book", async () => {
    const loadBytes = createLoadBytes(fakeDb("/tmp/marginalia-test.epub"));
    const bytes = await loadBytes("known");
    expect(bytes).toBeInstanceOf(Uint8Array);
    expect(Array.from(bytes)).toEqual([1, 2, 3]);
  });
  it("throws for an unknown book", async () => {
    const loadBytes = createLoadBytes(fakeDb(null));
    await expect(loadBytes("missing")).rejects.toThrow(/missing/);
  });
});
