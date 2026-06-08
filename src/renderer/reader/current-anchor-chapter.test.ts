import { describe, expect, it } from "vitest";
import { pickAnchorChapterId } from "./current-anchor-chapter";

// 入参：本 section 内的锚点章（按文档位置升序，含各自 anchor 的 offsetTop 像素）+ 视口顶在 section 内的像素位置。
const chs = [
  { id: "c1", anchor: "a1", top: 0 },
  { id: "c2", anchor: "a2", top: 500 },
  { id: "c3", anchor: "a3", top: 1200 },
];

describe("pickAnchorChapterId", () => {
  it("picks the last chapter whose anchor is at or above the viewport top", () => {
    expect(pickAnchorChapterId(chs, 0)).toBe("c1");
    expect(pickAnchorChapterId(chs, 400)).toBe("c1");
    expect(pickAnchorChapterId(chs, 500)).toBe("c2");
    expect(pickAnchorChapterId(chs, 1300)).toBe("c3");
  });
  it("empty ⇒ null", () => {
    expect(pickAnchorChapterId([], 0)).toBeNull();
  });
});
