import { describe, expect, it } from "vitest";
import { localDayKey } from "@main/stats/day-key";

// 用「本地分量构造 → 读回本地分量」避免测试机时区依赖：noon/边界都用本地时间字面量。
describe("localDayKey", () => {
  it("formats local date as YYYY-MM-DD", () => {
    const ms = new Date("2026-06-09T12:00:00").getTime();
    expect(localDayKey(ms)).toBe("2026-06-09");
  });
  it("zero-pads month and day", () => {
    const ms = new Date("2026-01-05T08:30:00").getTime();
    expect(localDayKey(ms)).toBe("2026-01-05");
  });
  it("rolls to next day after local midnight", () => {
    expect(localDayKey(new Date("2026-06-09T23:30:00").getTime())).toBe("2026-06-09");
    expect(localDayKey(new Date("2026-06-10T00:30:00").getTime())).toBe("2026-06-10");
  });
});
