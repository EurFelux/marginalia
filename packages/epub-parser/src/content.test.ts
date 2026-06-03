import { describe, expect, it } from "vitest";
import { extractBookText, extractChapterText, htmlToText } from "./content";
import { makeFixtureEpub } from "./fixture";

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
