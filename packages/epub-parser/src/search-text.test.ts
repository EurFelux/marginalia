import { strToU8, zipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { makeFixtureEpub } from "./fixture";
import { sectionTextFlow, spineHrefs } from "./search-text";

const allFlows = (bytes: Uint8Array) =>
  spineHrefs(bytes).map((href) => sectionTextFlow(bytes, href)!);

function oneFileEpub(body: string): Uint8Array {
  return zipSync({
    mimetype: [strToU8("application/epub+zip"), { level: 0 }],
    "META-INF/container.xml": strToU8(`<?xml version="1.0"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles>
</container>`),
    "OEBPS/content.opf": strToU8(`<?xml version="1.0" encoding="utf-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0">
  <manifest><item id="s1" href="text/s1.xhtml" media-type="application/xhtml+xml"/></manifest>
  <spine><itemref idref="s1"/></spine>
</package>`),
    "OEBPS/text/s1.xhtml": strToU8(
      `<html><head><title>Ignored</title><style>p{}</style></head><body>${body}</body></html>`,
    ),
  });
}

describe("sectionTextFlow", () => {
  it("returns one text flow per spine file in reading order", () => {
    const flows = allFlows(makeFixtureEpub());
    expect(flows.map((f) => f.href)).toEqual(["OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml"]);
    expect(flows[0]!.text).toBe("Chapter OneHello world.Second paragraph.");
    expect(flows[0]!.breaks).toEqual([0, 11, 23, 40]);
  });

  it("keeps text the AI extraction drops: tables and div paragraphs", () => {
    const [flow] = allFlows(
      oneFileEpub(`<h1>Head</h1><div>div para</div><table><tr><td>cell</td></tr></table>`),
    );
    expect(flow!.text).toBe("Headdiv paracell");
  });

  it("decodes entities, skips head and scripts, and records element ids", () => {
    const [flow] = allFlows(
      oneFileEpub(`<p id="a1">A &amp; B</p><script>x()</script><p><span id="a2">C</span></p>`),
    );
    expect(flow!.text).toBe("A & BC");
    expect(flow!.anchors).toEqual({ a1: 0, a2: 5 });
  });

  it("reads the spine and single sections without inflating unrelated entries", () => {
    const bytes = makeFixtureEpub();
    expect(spineHrefs(bytes)).toEqual(["OEBPS/ch1.xhtml", "OEBPS/ch2.xhtml"]);
    expect(sectionTextFlow(bytes, "OEBPS/ch2.xhtml")?.text).toBe("Chapter TwoThe end.");
    expect(sectionTextFlow(bytes, "OEBPS/missing.xhtml")).toBeNull();
  });
});
