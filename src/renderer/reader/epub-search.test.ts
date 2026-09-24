// @vitest-environment happy-dom
import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { sectionTextFlow } from "@marginalia/epub-parser";
import { domTextFlow, searchHitElement, searchPositions, type DomPosition } from "./epub-search";

const docOf = (body: string) =>
  new DOMParser().parseFromString(
    `<html><head><title>t</title></head><body>${body}</body></html>`,
    "text/html",
  );

/** 同一段 body 打成单文件 epub，交给主进程侧的文本流构建。 */
function mainSideFlow(body: string) {
  const bytes = zipSync({
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    "content.opf": strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest><item id="s" href="s.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="s"/></spine>
</package>`),
    "s.xhtml": strToU8(`<html><head><title>t</title></head><body>${body}</body></html>`),
  });
  return sectionTextFlow(bytes, "s.xhtml")!;
}

const BODY = `
  <h1 id="top">The Margin</h1>
  <p>Readers kept their <em>truest</em> thoughts in the margin &amp; the gutter.</p>
  <div>A div paragraph about margins.</div>
  <table><tr><td>margin cell</td></tr></table>
  <script>var margin = 1;</script>
`;

describe("domTextFlow", () => {
  it("produces the same text flow as the main process for the same markup", () => {
    const dom = domTextFlow(docOf(BODY));
    const main = mainSideFlow(BODY);
    expect(dom.text).toBe(main.text);
    expect(dom.breaks).toEqual(main.breaks);
    expect(Object.fromEntries(dom.anchors)).toEqual(main.anchors);
  });
});

/** 两个 DOM 位置之间的文字（按文档序遍历文本节点；happy-dom 的 Range.toString 不可用）。 */
function textBetween(doc: Document, start: DomPosition, end: DomPosition): string {
  const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
  let out = "";
  let inside = false;
  for (let t = walker.nextNode(); t; t = walker.nextNode()) {
    const value = t.nodeValue ?? "";
    const from = t === start.node ? start.offset : 0;
    if (t === start.node) inside = true;
    if (!inside) continue;
    if (t === end.node) return out + value.slice(from, end.offset);
    out += value.slice(from);
  }
  return out;
}

describe("searchPositions", () => {
  it("locates every match, including ones spanning inline elements", () => {
    const doc = docOf(BODY);
    const text = (q: string) =>
      searchPositions(doc, q).map((p) => textBetween(doc, p.start, p.end));
    expect(text("margin")).toEqual(["Margin", "margin", "margin", "margin"]);
    expect(text("their truest thoughts")).toEqual(["their truest thoughts"]);
  });
});

describe("searchHitElement", () => {
  it("picks the occurrence the main process counted", () => {
    const doc = docOf(BODY);
    expect(searchHitElement(doc, "margin", 2)?.localName).toBe("div");
  });

  it("falls back to the last match when the occurrence is out of range", () => {
    const doc = docOf(BODY);
    expect(searchHitElement(doc, "margin", 99)?.localName).toBe("td");
  });

  it("returns null when nothing matches", () => {
    expect(searchHitElement(docOf(BODY), "absent", 0)).toBeNull();
  });
});
