import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@renderer/store/persist-preference", () => ({ persistPreference: vi.fn() }));

import { usePrefsStore, PREFS_INITIAL } from "@renderer/store/prefs-store";

beforeEach(() => usePrefsStore.setState(PREFS_INITIAL));

describe("prefs-store", () => {
  it("updatePrefs merges patch, keeps other fields", () => {
    usePrefsStore.getState().updatePrefs({ fontScale: 1.2 });
    expect(usePrefsStore.getState().prefs.fontScale).toBe(1.2);
    expect(usePrefsStore.getState().prefs.maxWidth).toBe(640);
  });
  it("setLastHighlightStyle updates style", () => {
    usePrefsStore.getState().setLastHighlightStyle("blue");
    expect(usePrefsStore.getState().lastHighlightStyle).toBe("blue");
  });
  it("setAutoSummarize updates flag", () => {
    usePrefsStore.getState().setAutoSummarize(true);
    expect(usePrefsStore.getState().autoSummarize).toBe(true);
  });
});
