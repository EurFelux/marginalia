import { describe, expect, it } from "vitest";
import {
  intraPageRatio,
  PAGE_GAP,
  PAGE_PADDING_Y,
  scrollTopFor,
  topPageAt,
  zoomScrollLeft,
  zoomScrollOffset,
} from "./pdf-scroll";

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
  it("页缝里的 scrollTop 还原误差不超过一整缝（clamp 行为）", () => {
    // 整条页缝 [内容底, 下页内容顶) 全归下一页；最大误差 = PAGE_GAP（y=1008 是最坏点）
    for (const y of [0, 8, 1008, 1018]) {
      const page = topPageAt(y, pageH, 10);
      const back = scrollTopFor(page, intraPageRatio(y, page, pageH), pageH);
      expect(Math.abs(back - y)).toBeLessThanOrEqual(PAGE_GAP);
    }
  });
});

describe("zoomScrollOffset（缩放竖向复位：Virtuoso scrollToIndex offset）", () => {
  // Virtuoso align:'start' 把第 page 页（itemHeight = pageH + PAGE_GAP）顶对齐视口顶，
  // 即落点 scrollTop = (page-1)*(pageH+PAGE_GAP) + offset。offset 应把 ratio 处内容钉在 anchorY。
  const virtuosoItemTop = (page: number, ph: number) => (page - 1) * (ph + PAGE_GAP);

  it("anchorY=0、ratio=0 时 offset = 页上缝 PAGE_PADDING_Y", () => {
    expect(zoomScrollOffset(0, 1000, 0)).toBe(PAGE_PADDING_Y);
  });

  it("offset = PAGE_PADDING_Y + ratio*pageH - anchorY", () => {
    expect(zoomScrollOffset(0.5, 1000, 300)).toBe(PAGE_PADDING_Y + 500 - 300);
  });

  it("与 scrollTopFor 几何自洽：itemTop + offset == 锚点内容点落在视口 anchorY", () => {
    // 任意页/比例/新 pageH/锚点，最终 scrollTop 应让锚点内容点恰在视口 anchorY 处
    for (const [page, ratio, newPageH, anchorY] of [
      [3, 0.4, 1200, 300],
      [1, 0, 800, 0],
      [10, 1, 1500, 720],
    ] as const) {
      const finalScrollTop =
        virtuosoItemTop(page, newPageH) + zoomScrollOffset(ratio, newPageH, anchorY);
      expect(finalScrollTop).toBeCloseTo(scrollTopFor(page, ratio, newPageH) - anchorY, 10);
    }
  });
});

describe("zoomScrollLeft（缩放横向复位：缩放到点）", () => {
  it("scale=1 时横向不动（原值，非负）", () => {
    expect(zoomScrollLeft(120, 200, 1)).toBe(120);
  });

  it("放大 scale=2：锚点 X 处内容钉回 anchorX", () => {
    expect(zoomScrollLeft(0, 100, 2)).toBe(100);
  });

  it("负结果 clamp 到 0（缩小到溢出消失）", () => {
    expect(zoomScrollLeft(0, 50, 0.5)).toBe(0);
  });
});
