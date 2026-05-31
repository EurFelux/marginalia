import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { makeFixtureEpub } from "./fixture";
import { parseEpub } from "./parse";

describe("parseEpub", () => {
  const parsed = () => parseEpub(makeFixtureEpub());

  it("reads metadata", () => {
    const p = parsed();
    expect(p.uid).toBe("urn:uuid:fixture-001");
    expect(p.title).toBe("Fixture Book");
    expect(p.author).toBe("Test Author");
    expect(p.cover && p.cover.byteLength).toBeGreaterThan(0);
  });

  it("reads spine in order with resolved hrefs", () => {
    const p = parsed();
    expect(p.spine.map((s) => s.href)).toEqual(["OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml"]);
    expect(p.spine.map((s) => s.id)).toEqual(["ch1", "ch2"]);
  });

  it("reads the EPUB3 nav TOC", () => {
    expect(parsed().toc).toEqual([
      { label: "Chapter One", href: "OEBPS/ch1.xhtml" },
      { label: "Chapter Two", href: "OEBPS/ch2.xhtml" },
    ]);
  });

  it("returns uid as a string even when dc:identifier is purely numeric", () => {
    const container = `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`;
    const opf = `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">9781234567890</dc:identifier>
    <dc:title>Numeric ID Book</dc:title>
  </metadata>
  <manifest>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml" properties="nav"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`;
    const nav = `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml"><body><nav><ol>
  <li><a href="ch1.xhtml">Ch1</a></li>
</ol></nav></body></html>`;
    const bytes = zipSync({
      mimetype: [strToU8("application/epub+zip"), { level: 0 }],
      "META-INF/container.xml": strToU8(container),
      "content.opf": strToU8(opf),
      "ch1.xhtml": strToU8(nav),
    });
    const result = parseEpub(bytes);
    expect(result.uid).toBe("9781234567890");
    expect(typeof result.uid).toBe("string");
  });
});
