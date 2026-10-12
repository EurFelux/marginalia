import { describe, expect, it } from "vitest";
import {
  inlineCountFor,
  moreDividerAfter,
  splitToolbarActions,
} from "@renderer/ai/selection-action-layout";

const list = (flags: boolean[]) => flags.map((enabled, i) => ({ id: `a${i}`, enabled }));
const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("inlineCountFor", () => {
  it("shows more actions inline when only icons are shown", () => {
    expect(inlineCountFor(true)).toBe(4);
    expect(inlineCountFor(false)).toBe(8);
  });
});

describe("splitToolbarActions", () => {
  it("handles no shown actions", () => {
    expect(splitToolbarActions(list([false, false]), 4)).toEqual({ inline: [], overflow: [] });
  });

  it("puts nothing under More when the shown actions exactly fill the row", () => {
    const { inline, overflow } = splitToolbarActions(list([true, true, true, true]), 4);
    expect(ids(inline)).toEqual(["a0", "a1", "a2", "a3"]);
    expect(overflow).toEqual([]);
  });

  it("moves the extra action under More and skips hidden ones", () => {
    const { inline, overflow } = splitToolbarActions(
      list([true, false, true, true, true, true]),
      4,
    );
    expect(ids(inline)).toEqual(["a0", "a2", "a3", "a4"]);
    expect(ids(overflow)).toEqual(["a5"]);
  });

  it("uses the icons-only count", () => {
    const { inline, overflow } = splitToolbarActions(list(Array(9).fill(true)), 8);
    expect(inline).toHaveLength(8);
    expect(ids(overflow)).toEqual(["a8"]);
  });
});

describe("moreDividerAfter", () => {
  it("is -1 when nothing goes under More", () => {
    expect(moreDividerAfter(list([true, true, true, true]), 4)).toBe(-1);
    expect(moreDividerAfter(list([true, true, true, true, false]), 4)).toBe(-1);
  });

  it("sits after the n-th shown action, not counting hidden ones", () => {
    expect(moreDividerAfter(list([true, true, true, true, true]), 4)).toBe(3);
    expect(moreDividerAfter(list([true, false, true, true, true, true]), 4)).toBe(4);
  });
});
