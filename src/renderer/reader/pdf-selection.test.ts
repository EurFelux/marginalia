// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { buildPdfSelectionInfo, flatOffsetOf } from "./pdf-selection";

function layer(spans: string[]): HTMLElement {
  const div = document.createElement("div");
  for (const s of spans) {
    const span = document.createElement("span");
    span.textContent = s;
    div.appendChild(span);
  }
  return div;
}

describe("flatOffsetOf", () => {
  it("accumulates text node lengths in document order", () => {
    const root = layer(["Hello ", "world", "!"]);
    const second = root.children[1]!.firstChild!;
    expect(flatOffsetOf(root, second, 0)).toBe(6);
    expect(flatOffsetOf(root, second, 3)).toBe(9);
  });
  it("returns null for a node outside the root", () => {
    const root = layer(["abc"]);
    const other = layer(["zzz"]);
    expect(flatOffsetOf(root, other.children[0]!.firstChild!, 0)).toBeNull();
  });
  it("returns null for an element (non-text) container", () => {
    const root = layer(["abc"]);
    expect(flatOffsetOf(root, root.children[0]!, 0)).toBeNull();
  });
});

describe("buildPdfSelectionInfo", () => {
  const rect = { x: 1, y: 2, width: 3, height: 4 };

  it("produces a locatorRange and a context window", () => {
    const pageStr = "A".repeat(400) + "TARGET" + "B".repeat(400);
    const info = buildPdfSelectionInfo({
      page: 7,
      pageStr,
      start: 400,
      end: 406,
      selectionText: "TARGET",
      rect,
    });
    expect(info.locatorRange).toBe('pdf:{"page":7,"start":400,"end":406}');
    expect(info.selectionText).toBe("TARGET");
    // 窗口 = 选区前后各 300 字符（pageStr 两端连续字母无空白，trim 不裁剪，长度精确）
    expect(info.paragraphCurrent).toHaveLength(300 + 6 + 300);
    expect(info.paragraphCurrent).toContain("TARGET");
    expect(info.paragraphBefore).toBeNull();
    expect(info.paragraphAfter).toBeNull();
    expect(info.rect).toEqual(rect);
  });

  it("clamps the window at page boundaries", () => {
    const info = buildPdfSelectionInfo({
      page: 1,
      pageStr: "short page text",
      start: 0,
      end: 5,
      selectionText: "short",
      rect,
    });
    expect(info.paragraphCurrent).toBe("short page text");
  });

  it("yields null locatorRange when offsets are unknown (cross-page / element container)", () => {
    const info = buildPdfSelectionInfo({
      page: 3,
      pageStr: "page text here",
      start: null,
      end: null,
      selectionText: "text",
      rect,
    });
    expect(info.locatorRange).toBeNull();
    expect(info.paragraphCurrent.length).toBeGreaterThan(0); // 上下文仍尽力提供
  });
});
