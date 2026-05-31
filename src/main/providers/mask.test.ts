import { describe, expect, it } from "vitest";
import { maskKey } from "@main/providers/mask";

describe("maskKey", () => {
  it("masks a typical key as prefix…last4", () => {
    expect(maskKey("sk-proj-ABCDEF1234")).toBe("sk-…1234");
  });
  it("fully masks keys of length <= 8 to avoid leaking", () => {
    expect(maskKey("short")).toBe("••••");
    expect(maskKey("12345678")).toBe("••••");
  });
  it("masks a 9-char key (prefix + last4)", () => {
    expect(maskKey("abcde1234")).toBe("abc…1234");
  });
});
