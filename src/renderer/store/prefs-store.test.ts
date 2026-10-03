import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@renderer/store/persist-preference", () => ({ persistPreference: vi.fn() }));

import { persistPreference } from "@renderer/store/persist-preference";
import { usePrefsStore, PREFS_INITIAL } from "@renderer/store/prefs-store";
import {
  DEFAULT_STEP_LIMIT,
  DEFAULT_BACKGROUND_CONCURRENCY,
  DEFAULT_BASH_ENABLED,
} from "@shared/preferences";

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
  it("bash is enabled by default and always-approve is not", () => {
    expect(DEFAULT_BASH_ENABLED).toBe(true);
    expect(PREFS_INITIAL.bashEnabled).toBe(DEFAULT_BASH_ENABLED);
    expect(PREFS_INITIAL.bashAlwaysApprove).toBe(false);
  });
  it("setBackgroundConcurrency updates value and persists", () => {
    usePrefsStore.getState().setBackgroundConcurrency(5);
    expect(usePrefsStore.getState().backgroundConcurrency).toBe(5);
    expect(persistPreference).toHaveBeenCalledWith({ key: "backgroundConcurrency", value: 5 });
  });
  it("backgroundConcurrency defaults to DEFAULT_BACKGROUND_CONCURRENCY", () => {
    expect(PREFS_INITIAL.backgroundConcurrency).toBe(DEFAULT_BACKGROUND_CONCURRENCY);
  });
});

describe("setSkillEnabled", () => {
  it("adds and removes names from the disabled list and persists it", () => {
    usePrefsStore.setState({ disabledSkills: [] });
    usePrefsStore.getState().setSkillEnabled("notes", false);
    usePrefsStore.getState().setSkillEnabled("notes", false);
    expect(usePrefsStore.getState().disabledSkills).toEqual(["notes"]);
    usePrefsStore.getState().setSkillEnabled("notes", true);
    expect(usePrefsStore.getState().disabledSkills).toEqual([]);
    expect(persistPreference).toHaveBeenLastCalledWith({ key: "disabledSkills", value: [] });
  });
});
