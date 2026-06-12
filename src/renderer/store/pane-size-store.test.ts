import { describe, expect, it } from "vitest";
import {
  clampPaneWidth,
  DEFAULT_SIDEBAR_WIDTH,
  PANE_WIDTH_LIMITS,
  usePaneSizeStore,
} from "@renderer/store/pane-size-store";

describe("clampPaneWidth", () => {
  it("passes through values inside the range, rounded", () => {
    expect(clampPaneWidth(300)).toBe(300);
    expect(clampPaneWidth(300.6)).toBe(301);
  });

  it("clamps below min and above max", () => {
    expect(clampPaneWidth(0)).toBe(PANE_WIDTH_LIMITS.min);
    expect(clampPaneWidth(10_000)).toBe(PANE_WIDTH_LIMITS.max);
  });

  it("falls back to the default for non-finite input", () => {
    expect(clampPaneWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH);
    expect(clampPaneWidth(Number.POSITIVE_INFINITY)).toBe(DEFAULT_SIDEBAR_WIDTH);
  });
});

describe("pane size store", () => {
  it("defaults to the legacy w-64 width and clamps on set", () => {
    expect(usePaneSizeStore.getState().sidebarWidth).toBe(DEFAULT_SIDEBAR_WIDTH);
    usePaneSizeStore.getState().setSidebarWidth(5);
    expect(usePaneSizeStore.getState().sidebarWidth).toBe(PANE_WIDTH_LIMITS.min);
    usePaneSizeStore.getState().setSidebarWidth(333);
    expect(usePaneSizeStore.getState().sidebarWidth).toBe(333);
  });
});
