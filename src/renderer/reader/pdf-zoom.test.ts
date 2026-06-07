import { describe, expect, it } from "vitest";
import { clampPdfZoom, PDF_ZOOM_MAX, PDF_ZOOM_MIN, PDF_ZOOM_STEP } from "./pdf-zoom";

describe("clampPdfZoom", () => {
  it("区间内整百分比倍率原样保留", () => {
    expect(clampPdfZoom(1)).toBe(1);
    expect(clampPdfZoom(1.3)).toBe(1.3);
    expect(clampPdfZoom(PDF_ZOOM_MIN)).toBe(PDF_ZOOM_MIN);
    expect(clampPdfZoom(PDF_ZOOM_MAX)).toBe(PDF_ZOOM_MAX);
  });

  it("越界值收敛到端点 25% / 500%（含旧落盘值）", () => {
    expect(clampPdfZoom(0.1)).toBe(PDF_ZOOM_MIN);
    expect(clampPdfZoom(10)).toBe(PDF_ZOOM_MAX);
    expect(PDF_ZOOM_MIN).toBe(0.25);
    expect(PDF_ZOOM_MAX).toBe(5);
  });

  it("normalize 到百分比整数：输入带小数的百分比被取整", () => {
    expect(clampPdfZoom(0.876)).toBe(0.88); // 87.6% → 88%
    expect(clampPdfZoom(1.111)).toBe(1.11); // 111.1% → 111%
  });

  it("±0.1 连加的浮点累计误差不外泄", () => {
    // 1 + 0.1 + 0.1 === 1.2000000000000002
    expect(clampPdfZoom(1 + PDF_ZOOM_STEP + PDF_ZOOM_STEP)).toBe(1.2);
    // 连续步进 5 次仍是干净值
    let zoom = 1;
    for (let i = 0; i < 5; i++) zoom = clampPdfZoom(zoom + PDF_ZOOM_STEP);
    expect(zoom).toBe(1.5);
  });
});
