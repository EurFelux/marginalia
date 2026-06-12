// @vitest-environment happy-dom
import { describe, expect, it } from "vitest";
import { segmentParagraphs } from "./segment-paragraphs";

function docFrom(html: string): Document {
  const doc = document.implementation.createHTMLDocument("t");
  doc.body.innerHTML = html;
  return doc;
}

describe("segmentParagraphs", () => {
  it("extracts simple paragraphs in order", () => {
    const doc = docFrom("<p>First.</p><p>Second.</p>");
    const paras = segmentParagraphs(doc.body);
    expect(paras.map((p) => p.text)).toEqual(["First.", "Second."]);
    expect(paras[0]!.element.tagName).toBe("P");
  });
  it("takes innermost block for nested blocks (no duplication)", () => {
    const doc = docFrom("<blockquote><p>Quoted text.</p></blockquote><li><p>Item.</p></li>");
    expect(segmentParagraphs(doc.body).map((p) => p.text)).toEqual(["Quoted text.", "Item."]);
  });
  it("normalizes whitespace across inline elements", () => {
    const doc = docFrom("<p>Hello\n  <em>brave</em>\n  world</p>");
    expect(segmentParagraphs(doc.body)[0]!.text).toBe("Hello brave world");
  });
  it("skips empty and punctuation-only blocks", () => {
    const doc = docFrom("<p>   </p><p>***</p><p>Real.</p>");
    expect(segmentParagraphs(doc.body).map((p) => p.text)).toEqual(["Real."]);
  });
  it("skips hidden subtrees", () => {
    const doc = docFrom("<div hidden><p>Invisible.</p></div><p>Visible.</p>");
    expect(segmentParagraphs(doc.body).map((p) => p.text)).toEqual(["Visible."]);
  });
  it("headings and figcaptions are paragraphs", () => {
    const doc = docFrom("<h1>Title</h1><figure><img/><figcaption>Caption.</figcaption></figure>");
    expect(segmentParagraphs(doc.body).map((p) => p.text)).toEqual(["Title", "Caption."]);
  });
  it("leaf div with bare text is a paragraph", () => {
    const doc = docFrom("<div><div>Bare div text.</div><p>Para.</p></div>");
    expect(segmentParagraphs(doc.body).map((p) => p.text)).toEqual(["Bare div text.", "Para."]);
  });
});
