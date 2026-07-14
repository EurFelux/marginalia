import { describe, expect, it } from "vitest";
import { resolveBookDestination } from "@renderer/reading/route-state";

describe("resolveBookDestination", () => {
  it.each([
    ["not-started", "auto", "start"],
    ["reading", "auto", "reader-active"],
    ["finished", "auto", "report"],
    ["finished", "reference", "reader-reference"],
    ["reading", "reference", "reader-active"],
    ["not-started", "reference", "start"],
  ] as const)("routes %s books in %s mode to %s", (state, mode, destination) => {
    expect(resolveBookDestination(state, mode)).toBe(destination);
  });
});
