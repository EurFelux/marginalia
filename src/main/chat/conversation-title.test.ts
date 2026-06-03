import { describe, expect, it } from "vitest";
import { deriveConversationTitle } from "@main/chat/conversation-title";

describe("deriveConversationTitle", () => {
  it("returns short single-line text as-is", () => {
    expect(deriveConversationTitle("关于灯塔的光")).toBe("关于灯塔的光");
  });
  it("takes the first non-empty line", () => {
    expect(deriveConversationTitle("\n  第一行  \n第二行")).toBe("第一行");
  });
  it("collapses inner whitespace", () => {
    expect(deriveConversationTitle("hello   world\t!")).toBe("hello world !");
  });
  it("truncates over 40 chars with ellipsis", () => {
    const long = "a".repeat(50);
    const out = deriveConversationTitle(long);
    expect(out).toBe("a".repeat(40) + "…");
    expect([...out].length).toBe(41); // oxlint-disable-line no-misused-spread
  });
  it("returns empty string for blank input", () => {
    expect(deriveConversationTitle("   \n\t  ")).toBe("");
  });
});
