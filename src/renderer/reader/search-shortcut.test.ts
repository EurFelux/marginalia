import { beforeEach, describe, expect, it } from "vitest";
import { NAVIGATION_INITIAL, useNavigationStore } from "@renderer/store/navigation-store";
import { PREFS_INITIAL, usePrefsStore } from "@renderer/store/prefs-store";
import { SEARCH_INITIAL, useSearchStore } from "@renderer/store/search-store";
import { isFindShortcut, openBookSearch } from "./search-shortcut";

const key = (over: Partial<KeyboardEvent>) =>
  ({
    key: "f",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...over,
  }) as KeyboardEvent;

describe("isFindShortcut", () => {
  it("is ⌘F on macOS and Ctrl+F elsewhere", () => {
    expect(isFindShortcut(key({ metaKey: true }), true)).toBe(true);
    expect(isFindShortcut(key({ ctrlKey: true }), true)).toBe(false);
    expect(isFindShortcut(key({ ctrlKey: true }), false)).toBe(true);
    expect(isFindShortcut(key({ metaKey: true }), false)).toBe(false);
  });

  it("accepts an upper-case F from caps lock but not extra modifiers", () => {
    expect(isFindShortcut(key({ metaKey: true, key: "F" }), true)).toBe(true);
    expect(isFindShortcut(key({ metaKey: true, shiftKey: true }), true)).toBe(false);
    expect(isFindShortcut(key({ metaKey: true, altKey: true }), true)).toBe(false);
  });

  it("ignores a plain f", () => {
    expect(isFindShortcut(key({}), true)).toBe(false);
  });
});

describe("openBookSearch", () => {
  beforeEach(() => {
    usePrefsStore.setState(PREFS_INITIAL);
    useNavigationStore.setState(NAVIGATION_INITIAL);
    useSearchStore.setState(SEARCH_INITIAL);
  });

  it("expands a collapsed sidebar, switches it to the search tab and asks for input focus", () => {
    usePrefsStore.setState({ layout: { ...PREFS_INITIAL.layout, sidebarOpen: false } });
    useNavigationStore.getState().setSidebarTab("notes");
    openBookSearch();
    expect(usePrefsStore.getState().layout.sidebarOpen).toBe(true);
    expect(useNavigationStore.getState().sidebarTab).toBe("search");
    expect(useSearchStore.getState().focusNonce).toBe(1);
  });
});
