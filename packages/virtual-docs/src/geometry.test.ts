import { describe, expect, it } from "vitest";
import { toViewportRect } from "./geometry";

describe("toViewportRect", () => {
  it("adds the iframe's viewport offset to the in-iframe rect", () => {
    const r = toViewportRect({ left: 10, top: 20, width: 5, height: 8 }, { left: 100, top: 200 });
    expect(r).toEqual({ x: 110, y: 220, width: 5, height: 8 });
  });

  it("handles zero offset", () => {
    const r = toViewportRect({ left: 3, top: 4, width: 1, height: 2 }, { left: 0, top: 0 });
    expect(r).toEqual({ x: 3, y: 4, width: 1, height: 2 });
  });
});
