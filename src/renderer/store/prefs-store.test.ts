import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@renderer/store/persist-preference", () => ({ persistPreference: vi.fn() }));

import { persistPreference } from "@renderer/store/persist-preference";
import { usePrefsStore, PREFS_INITIAL } from "@renderer/store/prefs-store";
import { DEFAULT_STEP_LIMIT } from "@shared/preferences";

beforeEach(() => {
  usePrefsStore.setState(PREFS_INITIAL);
  vi.clearAllMocks();
});

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
  it("updateLayout merges patch, keeps other flags, persists whole object", () => {
    usePrefsStore.getState().updateLayout({ panelOpen: true });
    expect(usePrefsStore.getState().layout).toEqual({
      sidebarOpen: true,
      panelOpen: true,
      headerOpen: true,
    });
    expect(persistPreference).toHaveBeenCalledWith({
      key: "readerLayout",
      value: { sidebarOpen: true, panelOpen: true, headerOpen: true },
    });
  });
  it("layout defaults to sidebar+header open, panel closed", () => {
    expect(PREFS_INITIAL.layout).toEqual({
      sidebarOpen: true,
      panelOpen: false,
      headerOpen: true,
    });
  });
  it("setStepLimit updates value and persists", () => {
    usePrefsStore.getState().setStepLimit(0);
    expect(usePrefsStore.getState().stepLimit).toBe(0);
    expect(persistPreference).toHaveBeenCalledWith({ key: "stepLimit", value: 0 });
  });
  it("stepLimit defaults to DEFAULT_STEP_LIMIT", () => {
    expect(PREFS_INITIAL.stepLimit).toBe(DEFAULT_STEP_LIMIT);
  });
});
