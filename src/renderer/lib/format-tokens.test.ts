import { describe, expect, it } from "vitest";
import { formatTokens } from "@renderer/lib/format-tokens";

describe("formatTokens", () => {
  it("keeps numbers below 1000 as they are", () => {
    expect(formatTokens(0, "en")).toBe("0");
    expect(formatTokens(912, "en")).toBe("912");
    expect(formatTokens(999, "en")).toBe("999");
  });

  it("switches to k, M and B with one decimal, dropping a trailing .0", () => {
    expect(formatTokens(1000, "en")).toBe("1k");
    expect(formatTokens(37060, "en")).toBe("37.1k");
    expect(formatTokens(16900, "en")).toBe("16.9k");
    expect(formatTokens(128_400, "en")).toBe("128.4k");
    expect(formatTokens(1_000_000, "en")).toBe("1M");
    expect(formatTokens(2_345_678, "en")).toBe("2.3M");
    expect(formatTokens(1_500_000_000, "en")).toBe("1.5B");
    expect(formatTokens(1_234_000_000_000, "en")).toBe("1,234B");
  });

  it("carries into the next unit when rounding reaches 1000", () => {
    expect(formatTokens(999_949, "en")).toBe("999.9k");
    expect(formatTokens(999_950, "en")).toBe("1M");
    expect(formatTokens(999_999_999, "en")).toBe("1B");
  });

  it("uses the locale's number format", () => {
    expect(formatTokens(37060, "zh-CN")).toBe("37.1k");
    expect(formatTokens(37060, "de")).toBe("37,1k");
  });
});
