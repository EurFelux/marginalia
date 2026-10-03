import { describe, expect, it } from "vitest";
import { formatList } from "@renderer/lib/list-format";

describe("formatList", () => {
  it("spaces out Chinese conjunctions next to paths", () => {
    expect(formatList(["~/.agents/skills", "~/.claude/skills"], "zh-CN")).toBe(
      "~/.agents/skills 和 ~/.claude/skills",
    );
    expect(formatList(["a", "b", "c"], "zh-CN")).toBe("a、b 和 c");
  });

  it("leaves other languages as Intl formats them", () => {
    expect(formatList(["~/.agents/skills", "~/.claude/skills"], "en")).toBe(
      "~/.agents/skills and ~/.claude/skills",
    );
    expect(formatList(["a", "b", "c"], "en")).toBe("a, b, and c");
  });
});
