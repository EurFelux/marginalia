import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { extractBookText, extractChapterText, htmlToText } from "./content";
import { makeFixtureEpub } from "./fixture";

function anchorEpub(): Uint8Array {
  const big = `<html><body>
<p>封面无关文字</p>
<p><span id="a1">第1章 标题</span></p>
<p>第一章正文段落。</p>
<p><span id="a2">第2章 标题</span></p>
<p>第二章正文段落。</p>
</body></html>`;
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "big.xhtml": strToU8(big),
  });
}

describe("htmlToText", () => {
  it("joins block text with newlines and collapses whitespace", () => {
    const t = htmlToText(`<html><body><h1>Title</h1><p>A  b</p><p>c</p></body></html>`);
    expect(t).toBe("Title\nA b\nc");
  });

  it("nested list: no duplication of child li text", () => {
    const t = htmlToText(
      `<html><body><ul><li>Parent<ul><li>Child</li></ul></li></ul></body></html>`,
    );
    expect(t.split("Child").length - 1).toBe(1);
    expect(t).toContain("Parent");
  });

  it("blockquote>p: no duplication of paragraph text", () => {
    const t = htmlToText(`<html><body><blockquote><p>quoted</p></blockquote></body></html>`);
    expect(t.split("quoted").length - 1).toBe(1);
  });

  it("figcaption is captured", () => {
    const t = htmlToText(
      `<html><body><figure><figcaption>Cap</figcaption></figure><p>After</p></body></html>`,
    );
    expect(t).toContain("Cap");
    expect(t).toContain("After");
  });
});

describe("extractChapterText", () => {
  const bytes = makeFixtureEpub();
  it("extracts plain text from a chapter href", () => {
    const r = extractChapterText(bytes, "OEBPS/ch1.xhtml", {});
    expect(r.text).toContain("Chapter One");
    expect(r.text).toContain("Hello world.");
    expect(r.hasMore).toBe(false);
  });
  it("paginates by maxChars", () => {
    const r = extractChapterText(bytes, "OEBPS/ch1.xhtml", { offset: 0, maxChars: 5 });
    expect(r.text.length).toBe(5);
    expect(r.hasMore).toBe(true);
    expect(r.nextOffset).toBe(5);
  });
  it("throws on a missing entry", () => {
    expect(() => extractChapterText(bytes, "OEBPS/nope.xhtml", {})).toThrow(/missing entry/);
  });

  it("offset past end returns empty text with hasMore false and clamped nextOffset", () => {
    const r = extractChapterText(bytes, "OEBPS/ch1.xhtml", { offset: 999999 });
    expect(r.text).toBe("");
    expect(r.hasMore).toBe(false);
    // nextOffset must not exceed the actual chapter text length
    const chapterFull = extractChapterText(bytes, "OEBPS/ch1.xhtml", {}).text;
    expect(r.nextOffset).toBeLessThanOrEqual(chapterFull.length);
  });
});

describe("extractBookText", () => {
  const bytes = makeFixtureEpub();
  it("concatenates the given hrefs in order (single unzip)", () => {
    const r = extractBookText(bytes, ["OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml"], { maxChars: 100_000 });
    expect(r.truncated).toBe(false);
    expect(r.text).toContain("Hello world."); // ch1
    expect(r.text).toContain("The end."); // ch2
    expect(r.text.indexOf("Hello world.")).toBeLessThan(r.text.indexOf("The end."));
  });
  it("truncates at maxChars across chapters", () => {
    const r = extractBookText(bytes, ["OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml"], { maxChars: 5 });
    expect(r.truncated).toBe(true);
    expect(r.text.length).toBeLessThanOrEqual(5);
  });
  it("skips hrefs missing from the zip (fault-tolerant)", () => {
    const r = extractBookText(bytes, ["OEBPS/nope.xhtml", "OEBPS/ch1.xhtml"], {
      maxChars: 100_000,
    });
    expect(r.text).toContain("Hello world.");
  });
});

describe("extractChapterText anchor slicing", () => {
  it("slices [anchor, nextAnchor) — first chapter", () => {
    const r = extractChapterText(anchorEpub(), "big.xhtml", {}, "a1", "a2");
    expect(r.text).toBe("第1章 标题\n第一章正文段落。");
    expect(r.hasMore).toBe(false);
  });

  it("slices to end of file — last chapter (no nextAnchor)", () => {
    const r = extractChapterText(anchorEpub(), "big.xhtml", {}, "a2");
    expect(r.text).toBe("第2章 标题\n第二章正文段落。");
  });

  it("anchor undefined ⇒ whole-file behavior (unchanged)", () => {
    const r = extractChapterText(anchorEpub(), "big.xhtml", {});
    expect(r.text).toContain("封面无关文字");
    expect(r.text).toContain("第二章正文段落。");
  });

  it("missing anchor element ⇒ degrades to whole file (no throw)", () => {
    const r = extractChapterText(anchorEpub(), "big.xhtml", {}, "nope");
    expect(r.text).toContain("封面无关文字");
  });
});
