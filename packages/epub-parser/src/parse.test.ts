import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { makeFixtureEpub } from "./fixture";
import { parseEpub } from "./parse";

// Helper to build minimal EPUBs inline.
function buildEpub(files: Record<string, string>): Uint8Array {
  const entries: Record<string, [Uint8Array, { level: 0 }] | Uint8Array> = {
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
  };
  for (const [k, v] of Object.entries(files)) {
    entries[k] = strToU8(v);
  }
  return zipSync(entries);
}

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

  it("EPUB2/NCX TOC path: parses navMap with nested navPoints", () => {
    const bytes = buildEpub({
      "META-INF/container.xml": `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
      "OEBPS/content.opf": `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="2.0" unique-identifier="bookid">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="bookid">urn:uuid:epub2-ncx-test</dc:identifier>
    <dc:title>NCX Book</dc:title>
  </metadata>
  <manifest>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch1a" href="ch1a.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine toc="ncx">
    <itemref idref="ch1"/>
    <itemref idref="ch1a"/>
  </spine>
</package>`,
      "OEBPS/toc.ncx": `<?xml version="1.0" encoding="utf-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <navMap>
    <navPoint id="np1">
      <navLabel><text>Chapter One</text></navLabel>
      <content src="ch1.xhtml"/>
      <navPoint id="np1a">
        <navLabel><text>Section 1.1</text></navLabel>
        <content src="ch1a.xhtml"/>
      </navPoint>
    </navPoint>
  </navMap>
</ncx>`,
      "OEBPS/ch1.xhtml": `<html><body><p>ch1</p></body></html>`,
      "OEBPS/ch1a.xhtml": `<html><body><p>ch1a</p></body></html>`,
    });
    const result = parseEpub(bytes);
    expect(result.toc).toHaveLength(1);
    expect(result.toc[0]!.label).toBe("Chapter One");
    expect(result.toc[0]!.href).toBe("OEBPS/ch1.xhtml");
    expect(result.toc[0]!.children).toHaveLength(1);
    expect(result.toc[0]!.children![0]!.label).toBe("Section 1.1");
    expect(result.toc[0]!.children![0]!.href).toBe("OEBPS/ch1a.xhtml");
  });

  it("multiple-nav selection: picks <nav epub:type='toc'>, not landmarks", () => {
    // landmarks nav appears BEFORE toc nav — parser must select the toc one
    const bytes = buildEpub({
      "META-INF/container.xml": `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
      "content.opf": `<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:title>Multi-nav Book</dc:title>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine><itemref idref="ch1"/></spine>
</package>`,
      "nav.xhtml": `<?xml version="1.0" encoding="utf-8"?>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
  <body>
    <nav epub:type="landmarks">
      <ol>
        <li><a href="landmarks.xhtml">Landmark Entry</a></li>
      </ol>
    </nav>
    <nav epub:type="toc">
      <ol>
        <li><a href="ch1.xhtml">Chapter One</a></li>
      </ol>
    </nav>
  </body>
</html>`,
      "ch1.xhtml": `<html><body><p>ch1</p></body></html>`,
    });
    const result = parseEpub(bytes);
    expect(result.toc).toHaveLength(1);
    expect(result.toc[0]!.label).toBe("Chapter One");
    expect(result.toc[0]!.href).toBe("ch1.xhtml");
  });

  it("uid null: missing dc:identifier yields uid === null", () => {
    const result = parseEpub(makeFixtureEpub({ identifier: null }));
    expect(result.uid).toBeNull();
  });

  it("cover via meta: EPUB2 cover fallback yields a non-empty cover Uint8Array", () => {
    const result = parseEpub(makeFixtureEpub({ coverViaMeta: true }));
    expect(result.cover).toBeInstanceOf(Uint8Array);
    expect(result.cover!.byteLength).toBeGreaterThan(0);
  });

  it("malformed OPF guard: OPF with no <package> root throws", () => {
    const bytes = buildEpub({
      "META-INF/container.xml": `<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`,
      "content.opf": `<?xml version="1.0" encoding="utf-8"?><nope/>`,
    });
    expect(() => parseEpub(bytes)).toThrow(
      /epub: OPF at "content\.opf" has no <package> root element/,
    );
  });
});
