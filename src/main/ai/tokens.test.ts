// src/main/ai/tokens.test.ts
import { describe, expect, it } from "vitest";
import { estimateTokens } from "@main/ai/tokens";

describe("estimateTokens", () => {
  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("counts CJK characters as ~1 token each", () => {
    // 4 个汉字 → 4 token
    expect(estimateTokens("你好世界")).toBe(4);
  });

  it("counts non-CJK as ~4 chars per token (ceil)", () => {
    // 8 个 ASCII → ceil(8/4) = 2
    expect(estimateTokens("abcdefgh")).toBe(2);
    // 5 个 ASCII → ceil(5/4) = 2
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("mixes CJK and ASCII additively", () => {
    // 2 汉字 + 4 ASCII → ceil(2 + 4/4) = ceil(3) = 3
    expect(estimateTokens("你好abcd")).toBe(3);
  });
});
