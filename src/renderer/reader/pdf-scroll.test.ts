import { describe, expect, it } from "vitest";
import { intraPageRatio, scrollTopFor, topPageAt } from "./pdf-scroll";

const pageH = 1000; // 每项总高 1016

describe("topPageAt", () => {
  it("容器顶与首页中部都算第 1 页", () => {
    expect(topPageAt(0, pageH, 10)).toBe(1);
    expect(topPageAt(500, pageH, 10)).toBe(1);
  });
  it("+8 归属规则与 PdfReader 原实现一致：1007 仍第 1 页、1008 起第 2 页", () => {
    expect(topPageAt(1007, pageH, 10)).toBe(1);
    expect(topPageAt(1008, pageH, 10)).toBe(2);
  });
  it("clamp 到 [1, pageCount]（负值与超末尾）", () => {
    expect(topPageAt(-50, pageH, 10)).toBe(1);
    expect(topPageAt(99999, pageH, 3)).toBe(3);
  });
});

describe("intraPageRatio ↔ scrollTopFor 往返", () => {
  it("ratio 往返一致（页中部）", () => {
    const y = scrollTopFor(3, 0.4, pageH);
    expect(intraPageRatio(y, 3, pageH)).toBeCloseTo(0.4, 10);
  });
  it("ratio 0 / 1 端点", () => {
    expect(intraPageRatio(scrollTopFor(2, 0, pageH), 2, pageH)).toBe(0);
    expect(intraPageRatio(scrollTopFor(2, 1, pageH), 2, pageH)).toBe(1);
  });
  it("页缝区间 clamp 到边界", () => {
    // 第 2 页内容顶 = 1016+8 = 1024；其上方 4px（缝里）→ 0；内容底下方 4px → 1
    expect(intraPageRatio(1020, 2, pageH)).toBe(0);
    expect(intraPageRatio(1024 + pageH + 4, 2, pageH)).toBe(1);
  });
  it("内容内的 scrollTop 经 (page, ratio) 精确还原", () => {
    const y = 1024 + 123.45; // 第 2 页内容里
    const page = topPageAt(y, pageH, 10);
    expect(page).toBe(2);
    expect(scrollTopFor(page, intraPageRatio(y, page, pageH), pageH)).toBeCloseTo(y, 10);
  });
  it("页缝里的 scrollTop 还原误差不超过半缝（clamp 行为）", () => {
    for (const y of [0, 8, 1018]) {
      const page = topPageAt(y, pageH, 10);
      const back = scrollTopFor(page, intraPageRatio(y, page, pageH), pageH);
      expect(Math.abs(back - y)).toBeLessThanOrEqual(8);
    }
  });
});
