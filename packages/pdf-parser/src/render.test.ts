import { describe, expect, it } from "vitest";
import { makeTextPdf } from "./fixture";
import { renderPageImage } from "./render";

const PNG_MAGIC = [0x89, 0x50, 0x4e, 0x47];

describe("renderPageImage", () => {
  it("renders a page to PNG bytes", async () => {
    const bytes = await makeTextPdf({ outline: false });
    const png = await renderPageImage(bytes, 1, { scale: 1 });
    expect(Array.from(png.slice(0, 4))).toEqual(PNG_MAGIC);
    expect(png.length).toBeGreaterThan(500);
  });

  it("computes scale from targetWidth", async () => {
    const bytes = await makeTextPdf({ outline: false });
    // fixture 页宽 400pt → targetWidth 200 = scale 0.5；PNG IHDR 宽度字段应为 200
    const png = await renderPageImage(bytes, 1, { targetWidth: 200 });
    // PNG IHDR: bytes 16-19 = width (big-endian u32)
    const width = (png[16]! << 24) | (png[17]! << 16) | (png[18]! << 8) | png[19]!;
    expect(width).toBe(200);
  });

  it("rejects non-positive scale/targetWidth instead of producing degenerate images", async () => {
    const bytes = await makeTextPdf({ outline: false });
    await expect(renderPageImage(bytes, 1, { scale: 0 })).rejects.toThrow(RangeError);
    await expect(renderPageImage(bytes, 1, { targetWidth: 0 })).rejects.toThrow(RangeError);
  });

  it("rejects out-of-range page numbers", async () => {
    const bytes = await makeTextPdf({ outline: false });
    await expect(renderPageImage(bytes, 99)).rejects.toThrow();
  });
});
