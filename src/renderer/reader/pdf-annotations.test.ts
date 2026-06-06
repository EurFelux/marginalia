// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import type { AnnotationDto } from "@shared/annotations";
import { pdfAnnosByPage, pdfOrderKey, rangeFromOffsets, relativeRects } from "./pdf-annotations";

function layer(spans: string[]): HTMLElement {
  const div = document.createElement("div");
  for (const s of spans) {
    const span = document.createElement("span");
    span.textContent = s;
    div.appendChild(span);
  }
  return div;
}

describe("rangeFromOffsets", () => {
  it("maps flat offsets back to node-local positions across spans", () => {
    const root = layer(["Hello ", "world", "!"]); // 偏移 6..9 = "wor"
    const r = rangeFromOffsets(root, 6, 9);
    expect(r).not.toBeNull();
    expect(r!.toString()).toBe("wor");
  });
  it("spans node boundaries", () => {
    const root = layer(["abc", "def"]); // 2..4 = "cd"
    expect(rangeFromOffsets(root, 2, 4)!.toString()).toBe("cd");
  });
  it("returns null for out-of-bounds or empty ranges", () => {
    const root = layer(["abc"]);
    expect(rangeFromOffsets(root, 2, 99)).toBeNull(); // end 越界（pdfjs 文本变化防御）
    expect(rangeFromOffsets(root, 2, 2)).toBeNull(); // 空区间
    expect(rangeFromOffsets(root, -1, 2)).toBeNull();
  });
});

describe("pdfAnnosByPage", () => {
  const anno = (id: string, locatorRange: string, note = ""): AnnotationDto => ({
    id,
    bookId: "b",
    style: "yellow",
    note,
    selectedText: "t",
    locatorRange,
    createdAt: 0,
    updatedAt: 0,
  });

  it("groups by page and maps note to hasNote", () => {
    const m = pdfAnnosByPage([
      anno("a", 'pdf:{"page":3,"start":0,"end":5}'),
      anno("b", 'pdf:{"page":3,"start":10,"end":15}', "memo"),
      anno("c", 'pdf:{"page":7,"start":1,"end":2}'),
    ]);
    expect(m.get(3)?.map((x) => x.id)).toEqual(["a", "b"]);
    expect(m.get(3)?.[1]?.hasNote).toBe(true);
    expect(m.get(7)?.length).toBe(1);
  });

  it("skips non-pdf locators (cfi) silently", () => {
    const m = pdfAnnosByPage([anno("x", "epubcfi(/6/4!/4/2)")]);
    expect(m.size).toBe(0);
  });
});

describe("pdfOrderKey", () => {
  it("orders by page then in-page offset; null for cfi", () => {
    const k1 = pdfOrderKey('pdf:{"page":2,"start":500,"end":501}');
    const k2 = pdfOrderKey('pdf:{"page":3,"start":0,"end":1}');
    const k3 = pdfOrderKey('pdf:{"page":3,"start":80,"end":81}');
    expect(k1! < k2!).toBe(true);
    expect(k2! < k3!).toBe(true);
    expect(pdfOrderKey("epubcfi(/6/4!/4)")).toBeNull();
  });
});

describe("relativeRects", () => {
  it("converts viewport rects to container-relative and drops slivers", () => {
    const out = relativeRects(
      [
        { x: 110, y: 220, width: 50, height: 14 },
        { x: 110, y: 240, width: 0.4, height: 14 }, // 零宽碎片
      ],
      { x: 100, y: 200 },
    );
    expect(out).toEqual([{ left: 10, top: 20, width: 50, height: 14 }]);
  });
});
