// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { isUpwardScrollIntent } from "./scroll-intent";

const wheel = (deltaY: number) => new WheelEvent("wheel", { deltaY });
const key = (k: string, shiftKey = false) => new KeyboardEvent("keydown", { key: k, shiftKey });

describe("isUpwardScrollIntent", () => {
  it("reads the wheel direction from deltaY", () => {
    expect(isUpwardScrollIntent(wheel(-40))).toBe(true);
    expect(isUpwardScrollIntent(wheel(40))).toBe(false);
    expect(isUpwardScrollIntent(wheel(0))).toBe(false);
  });

  it("treats the keys that scroll backwards as upward", () => {
    for (const k of ["ArrowUp", "PageUp", "Home"]) expect(isUpwardScrollIntent(key(k))).toBe(true);
    expect(isUpwardScrollIntent(key(" ", true))).toBe(true);
  });

  it("treats forward keys and unrelated keys as not upward", () => {
    for (const k of ["ArrowDown", "PageDown", "End", " ", "a", "Escape"])
      expect(isUpwardScrollIntent(key(k))).toBe(false);
  });

  it("cannot tell the direction from a touch start", () => {
    expect(isUpwardScrollIntent(new Event("touchstart"))).toBe(false);
  });

  it("judges by event type, not instanceof (iframe events come from another realm)", () => {
    const foreign = { type: "wheel", deltaY: -10 } as unknown as Event;
    expect(isUpwardScrollIntent(foreign)).toBe(true);
  });
});
