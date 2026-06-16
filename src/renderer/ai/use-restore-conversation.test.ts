import { describe, expect, it } from "vitest";
import { pickRestoreTarget, resolveRestore } from "@renderer/ai/use-restore-conversation";

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

describe("resolveRestore", () => {
  const state = (
    over?: Partial<{ activeByBook: Record<string, string | null> }> & {
      activeLibraryConversation?: string | null;
    },
  ) => ({ activeByBook: {}, activeLibraryConversation: null, ...over });

  it("book: restores the conversation remembered in activeByBook", () => {
    expect(
      resolveRestore({ kind: "book", bookId: "b1" }, state({ activeByBook: { b1: "c2" } }), list),
    ).toEqual({ kind: "restore", id: "c2" });
  });
  it("book empty state presets summary chips", () => {
    expect(
      resolveRestore({ kind: "book", bookId: "b1" }, state({ activeByBook: { b1: null } }), list),
    ).toEqual({ kind: "empty", presetSummaryChips: true });
  });
  it("library: restores the conversation remembered in activeLibraryConversation", () => {
    expect(
      resolveRestore({ kind: "library" }, state({ activeLibraryConversation: "c1" }), list),
    ).toEqual({ kind: "restore", id: "c1" });
  });
  it("library empty state does NOT preset summary chips (no book/chapter)", () => {
    expect(
      resolveRestore({ kind: "library" }, state({ activeLibraryConversation: null }), list),
    ).toEqual({ kind: "empty", presetSummaryChips: false });
  });
  it("library first use (null slot) opens a fresh conversation, not the latest", () => {
    // activeLibraryConversation 初值即 null → empty（开新会话），不回落 list[0]
    expect(resolveRestore({ kind: "library" }, state(), list)).toEqual({
      kind: "empty",
      presetSummaryChips: false,
    });
  });
});
