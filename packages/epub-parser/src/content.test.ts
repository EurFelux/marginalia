import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import {
  extractBookText,
  extractChapterAcrossSpine,
  extractChapterText,
  htmlToText,
} from "./content";
import { makeFixtureEpub } from "./fixture";

/**
 * 三段 spine 的 epub：中间文件 s2 不在任何目录项里（孤儿），逻辑上属于 s1 那一章。
 * 用来复现「TOC 章节正文横跨多个 spine 文件、孤儿文件被漏读」的 bug。
 */
function multiSpineEpub(): Uint8Array {
  const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">urn:uuid:multi-spine</dc:identifier><dc:title>Multi</dc:title></metadata>
  <manifest>
    <item id="s1" href="s1.xhtml" media-type="application/xhtml+xml"/>
    <item id="s2" href="s2.xhtml" media-type="application/xhtml+xml"/>
    <item id="s3" href="s3.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="s1"/><itemref idref="s2"/><itemref idref="s3"/></spine>
</package>`;
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    "OEBPS/content.opf": strToU8(opf),
    "OEBPS/s1.xhtml": strToU8(
      `<html><body><p>封面无关文字</p><p><span id="aA">第二章 概论</span></p><p>引子段落。</p></body></html>`,
    ),
    "OEBPS/s2.xhtml": strToU8(
      `<html><body><p>正文主体第一段。</p><p>正文主体第二段。</p></body></html>`,
    ),
    "OEBPS/s3.xhtml": strToU8(
      `<html><body><p><span id="aB">付诸行动</span></p><p>下一章正文。</p></body></html>`,
    ),
  });
}

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

describe("extractChapterAcrossSpine", () => {
  const bytes = multiSpineEpub();

  it("spans orphan spine files between two TOC boundaries (the bug)", () => {
    const r = extractChapterAcrossSpine(
      bytes,
      { href: "OEBPS/s1.xhtml", anchor: "aA" },
      { href: "OEBPS/s3.xhtml", anchor: "aB" },
      {},
    );
    expect(r.text).toContain("第二章 概论"); // 起始 anchor 所在块
    expect(r.text).toContain("引子段落。"); // s1 锚点之后
    expect(r.text).toContain("正文主体第一段。"); // ← 关键：孤儿 s2 不再丢
    expect(r.text).toContain("正文主体第二段。");
    expect(r.text).not.toContain("封面无关文字"); // 起始 anchor 之前不含
    expect(r.text).not.toContain("付诸行动"); // 下一章（end 边界）不含
    expect(r.text).not.toContain("下一章正文。");
    expect(r.hasMore).toBe(false);
  });

  it("reads to end of book when end is undefined (last chapter)", () => {
    const r = extractChapterAcrossSpine(
      bytes,
      { href: "OEBPS/s3.xhtml", anchor: "aB" },
      undefined,
      {},
    );
    expect(r.text).toContain("付诸行动");
    expect(r.text).toContain("下一章正文。");
  });

  it("same-file boundary slices [start.anchor, end.anchor) without crossing files", () => {
    // start 与 end 在同一文件 s1（aA → 文件内更后的锚点 z），不应吞入 s2/s3。
    const sameFile = zipSync({
      mimetype: [strToU8("application/epub+zip"), { level: 0 }],
      "META-INF/container.xml": strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
      "OEBPS/content.opf": strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="bid">urn:uuid:same</dc:identifier><dc:title>S</dc:title></metadata>
  <manifest><item id="s1" href="s1.xhtml" media-type="application/xhtml+xml"/><item id="s2" href="s2.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="s1"/><itemref idref="s2"/></spine>
</package>`),
      "OEBPS/s1.xhtml": strToU8(
        `<html><body><p><span id="aA">本节</span></p><p>本节正文。</p><p><span id="z">下节</span></p><p>下节正文。</p></body></html>`,
      ),
      "OEBPS/s2.xhtml": strToU8(`<html><body><p>另一文件不应纳入。</p></body></html>`),
    });
    const r = extractChapterAcrossSpine(
      sameFile,
      { href: "OEBPS/s1.xhtml", anchor: "aA" },
      { href: "OEBPS/s1.xhtml", anchor: "z" },
      {},
    );
    expect(r.text).toContain("本节");
    expect(r.text).toContain("本节正文。");
    expect(r.text).not.toContain("下节");
    expect(r.text).not.toContain("另一文件不应纳入。");
  });

  it("paginates the spanned text by offset/maxChars", () => {
    const r = extractChapterAcrossSpine(
      bytes,
      { href: "OEBPS/s1.xhtml", anchor: "aA" },
      { href: "OEBPS/s3.xhtml", anchor: "aB" },
      { offset: 0, maxChars: 4 },
    );
    expect(r.text.length).toBe(4);
    expect(r.hasMore).toBe(true);
    expect(r.nextOffset).toBe(4);
  });
});
