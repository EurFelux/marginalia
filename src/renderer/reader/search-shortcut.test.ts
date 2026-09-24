import { describe, expect, it } from "vitest";
import { isFindShortcut } from "./search-shortcut";

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
