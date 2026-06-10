import { describe, expect, it } from "vitest";
import type { AnnotationStyle } from "@shared/annotations";
import { hasNote, OVERLAY_FILL, overlayClass } from "./highlight";

describe("hasNote", () => {
  it("空串与纯空白不算有笔记", () => {
    expect(hasNote("")).toBe(false);
    expect(hasNote("   \n\t")).toBe(false);
  });
  it("非空内容算有笔记", () => {
    expect(hasNote("一条笔记")).toBe(true);
  });
});

describe("overlayClass", () => {
  const styles: AnnotationStyle[] = ["yellow", "green", "blue", "pink", "purple", "underline"];
  it("无笔记 = OVERLAY_FILL 原值（行为不变）", () => {
    for (const s of styles) expect(overlayClass(s, false)).toBe(OVERLAY_FILL[s]);
  });
  it("有笔记的填充色保留填充、叠点状底边", () => {
    for (const s of styles.filter((x) => x !== "underline")) {
      const cls = overlayClass(s, true);
      expect(cls).toContain(OVERLAY_FILL[s]);
      expect(cls).toContain("border-dotted");
    }
  });
  it("underline 有笔记时实线底边换点状（不叠两条线）", () => {
    expect(overlayClass("underline", true)).toBe("border-b-2 border-dotted border-foreground/60");
  });
});
