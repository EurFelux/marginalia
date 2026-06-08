import { describe, expect, it } from "vitest";
import { pickRestoreTarget } from "@renderer/ai/use-restore-conversation";

// listByBook 已按 updatedAt 倒序，list[0] 为最新
const list = [{ id: "c3" }, { id: "c2" }, { id: "c1" }];

describe("pickRestoreTarget", () => {
  it("hits remembered when it still exists", () => {
    expect(pickRestoreTarget(list, "c2")).toEqual({ kind: "restore", id: "c2" });
  });
  it("falls back to latest when remembered is missing (deleted)", () => {
    expect(pickRestoreTarget(list, "gone")).toEqual({ kind: "restore", id: "c3" });
  });
  it("restores empty state when remembered is null (last left on new-conversation)", () => {
    expect(pickRestoreTarget(list, null)).toEqual({ kind: "empty" });
  });
  it("falls back to latest when no memory (undefined key)", () => {
    expect(pickRestoreTarget(list, undefined)).toEqual({ kind: "restore", id: "c3" });
  });
  it("empty when book has no conversations", () => {
    expect(pickRestoreTarget([], undefined)).toEqual({ kind: "empty" });
  });
});
