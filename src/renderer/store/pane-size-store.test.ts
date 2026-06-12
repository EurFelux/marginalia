import { describe, expect, it } from "vitest";
import { clampPaneWidth, PANE_LIMITS, usePaneSizeStore } from "@renderer/store/pane-size-store";

describe("clampPaneWidth", () => {
  it("passes through values inside the range, rounded", () => {
    expect(clampPaneWidth("sidebar", 300)).toBe(300);
    expect(clampPaneWidth("sidebar", 300.6)).toBe(301);
    expect(clampPaneWidth("panel", 500)).toBe(500);
  });

  it("clamps below min and above max per pane", () => {
    expect(clampPaneWidth("sidebar", 0)).toBe(PANE_LIMITS.sidebar.min);
    expect(clampPaneWidth("sidebar", 10_000)).toBe(PANE_LIMITS.sidebar.max);
    expect(clampPaneWidth("panel", 0)).toBe(PANE_LIMITS.panel.min);
    expect(clampPaneWidth("panel", 10_000)).toBe(PANE_LIMITS.panel.max);
  });

  it("falls back to the pane default for non-finite input", () => {
    expect(clampPaneWidth("sidebar", Number.NaN)).toBe(PANE_LIMITS.sidebar.default);
    expect(clampPaneWidth("panel", Number.POSITIVE_INFINITY)).toBe(PANE_LIMITS.panel.default);
  });
});

describe("pane size store", () => {
  it("defaults to the legacy static widths and clamps on set", () => {
    expect(usePaneSizeStore.getState().sidebarWidth).toBe(PANE_LIMITS.sidebar.default);
    expect(usePaneSizeStore.getState().panelWidth).toBe(PANE_LIMITS.panel.default);
    usePaneSizeStore.getState().setSidebarWidth(5);
    expect(usePaneSizeStore.getState().sidebarWidth).toBe(PANE_LIMITS.sidebar.min);
    usePaneSizeStore.getState().setPanelWidth(9_999);
    expect(usePaneSizeStore.getState().panelWidth).toBe(PANE_LIMITS.panel.max);
    usePaneSizeStore.getState().setSidebarWidth(333);
    expect(usePaneSizeStore.getState().sidebarWidth).toBe(333);
  });
});
