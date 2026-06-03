import { describe, expect, it } from "vitest";
import { relativeParts, relativeTime } from "@renderer/lib/relative-time";

const NOW = 1_000_000_000_000;
const sec = 1000;
const day = 86_400 * sec;

describe("relativeParts", () => {
  it("now → 0 seconds", () => {
    expect(relativeParts(NOW, NOW)).toEqual({ value: 0, unit: "second" });
  });
  it("30s ago → -30 second", () => {
    expect(relativeParts(NOW - 30 * sec, NOW)).toEqual({ value: -30, unit: "second" });
  });
  it("3 days ago → -3 day", () => {
    expect(relativeParts(NOW - 3 * day, NOW)).toEqual({ value: -3, unit: "day" });
  });
});

describe("relativeTime", () => {
  it("formats via Intl for a locale (non-empty)", () => {
    expect(relativeTime(NOW - 3 * day, NOW, "en")).toMatch(/3 days ago/);
  });
});
