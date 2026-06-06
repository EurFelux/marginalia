import { describe, expect, it } from "vitest";
import { makePdfLocator, parsePdfLocator } from "./pdf-locator";

describe("pdf locator", () => {
  it("round-trips page + scrollRatio", () => {
    const s = makePdfLocator({ page: 12, scrollRatio: 0.35 });
    expect(s.startsWith("pdf:")).toBe(true);
    expect(parsePdfLocator(s)).toEqual({ page: 12, scrollRatio: 0.35 });
  });

  it("defaults missing scrollRatio to 0", () => {
    expect(parsePdfLocator('pdf:{"page":3}')).toEqual({ page: 3, scrollRatio: 0 });
  });

  it("returns null for CFI strings and garbage", () => {
    expect(parsePdfLocator("epubcfi(/6/4!/4/2)")).toBeNull();
    expect(parsePdfLocator("pdf:not-json")).toBeNull();
    expect(parsePdfLocator('pdf:{"page":0}')).toBeNull(); // page 必须 >= 1
  });
});
