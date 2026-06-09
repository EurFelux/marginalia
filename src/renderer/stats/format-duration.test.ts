import { describe, expect, it } from "vitest";
import { formatDuration } from "@renderer/stats/format-duration";

describe("formatDuration", () => {
  const f = (s: number) => formatDuration(s, "h", "m");
  it("formats sub-hour as minutes", () => {
    expect(f(2820)).toBe("47m"); // 47:00
    expect(f(60)).toBe("1m");
  });
  it("floors sub-minute to 0m", () => {
    expect(f(0)).toBe("0m");
    expect(f(59)).toBe("0m");
  });
  it("omits minutes when whole hours", () => {
    expect(f(3600)).toBe("1h");
    expect(f(7200)).toBe("2h");
  });
  it("shows hours and minutes", () => {
    expect(f(4320)).toBe("1h 12m"); // 72m
    expect(f(7320)).toBe("2h 2m");
  });
  it("clamps negatives to 0m", () => {
    expect(f(-10)).toBe("0m");
  });
});
