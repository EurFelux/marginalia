import { describe, expect, it } from "vitest";
import { splitForUtterance } from "./split-for-utterance";

describe("splitForUtterance", () => {
  it("returns short text as a single chunk", () => {
    expect(splitForUtterance("短句。", 300)).toEqual(["短句。"]);
  });
  it("splits long text at sentence boundaries within the limit", () => {
    const s1 = "天地玄黄宇宙洪荒。".repeat(5); // 45 chars
    const chunks = splitForUtterance(s1 + s1 + s1, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
    expect(chunks.join("")).toBe(s1 + s1 + s1);
  });
  it("falls back to comma splits for a single overlong sentence", () => {
    const long = "一二三四五六七八九十，".repeat(12).slice(0, -1) + "。"; // 单句 >100
    const chunks = splitForUtterance(long, 100);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(100);
  });
  it("never returns empty chunks", () => {
    for (const c of splitForUtterance("a。".repeat(500), 50)) expect(c.trim()).not.toBe("");
  });
});
