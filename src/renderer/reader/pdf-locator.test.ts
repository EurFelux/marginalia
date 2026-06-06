import { describe, expect, it } from "vitest";
import {
  makePdfLocator,
  parsePdfLocator,
  makePdfLocatorRange,
  parsePdfLocatorRange,
} from "./pdf-locator";

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

describe("pdf range locator", () => {
  it("round-trips", () => {
    const s = makePdfLocatorRange({ page: 12, start: 480, end: 527 });
    expect(s).toBe('pdf:{"page":12,"start":480,"end":527}');
    expect(parsePdfLocatorRange(s)).toEqual({ page: 12, start: 480, end: 527 });
  });
  it("rejects non-pdf prefixes and malformed json", () => {
    expect(parsePdfLocatorRange("epubcfi(/6/4!/4)")).toBeNull();
    expect(parsePdfLocatorRange("pdf:{nope")).toBeNull();
  });
  it("rejects invalid shapes", () => {
    expect(parsePdfLocatorRange('pdf:{"page":0,"start":0,"end":1}')).toBeNull();
    expect(parsePdfLocatorRange('pdf:{"page":1,"start":-1,"end":1}')).toBeNull();
    expect(parsePdfLocatorRange('pdf:{"page":1,"start":5,"end":4}')).toBeNull();
    expect(parsePdfLocatorRange('pdf:{"page":1,"scrollRatio":0.5}')).toBeNull(); // 进度形状不是 range
  });
});
