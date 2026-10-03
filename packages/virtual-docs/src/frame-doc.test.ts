// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { applyPaintCss, buildSrcDoc } from "./frame-doc";

const parse = (srcDoc: string) => new DOMParser().parseFromString(srcDoc, "text/html");

describe("buildSrcDoc", () => {
  it("wraps a fragment with both injected styles", () => {
    const doc = parse(buildSrcDoc("<p>hi</p>", "p{margin:0}", "body{color:red}"));
    expect(doc.getElementById("vd-style")?.textContent).toBe("p{margin:0}");
    expect(doc.getElementById("vd-paint")?.textContent).toBe("body{color:red}");
    expect(doc.body.innerHTML).toBe("<p>hi</p>");
  });

  it("injects before the book's own head content, style first then paint", () => {
    const html = "<html><head><style>p{color:blue}</style></head><body></body></html>";
    const ids = [...parse(buildSrcDoc(html, "a", "b")).head.children].map(
      (el) => el.id || el.tagName.toLowerCase(),
    );
    expect(ids).toEqual(["vd-style", "vd-paint", "style"]);
  });
});

describe("applyPaintCss", () => {
  it("replaces the paint style in place without touching the layout style", () => {
    const doc = parse(buildSrcDoc("<p>hi</p>", "p{margin:0}", ""));
    const paint = doc.getElementById("vd-paint");
    applyPaintCss(doc, "body{background:#000}");
    expect(doc.getElementById("vd-paint")).toBe(paint);
    expect(paint?.textContent).toBe("body{background:#000}");
    expect(doc.getElementById("vd-style")?.textContent).toBe("p{margin:0}");
  });

  it("is a no-op on documents without the paint style", () => {
    const doc = parse("<p>plain</p>");
    expect(() => applyPaintCss(doc, "x")).not.toThrow();
  });
});
