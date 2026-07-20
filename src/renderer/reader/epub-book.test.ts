// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { htmlToText } from "@marginalia/epub-parser";

vi.mock("@renderer/i18n", () => ({ default: { t: (_key: string, fallback: string) => fallback } }));

import { adaptTextScanSection, scanSectionTextProfiles, type TextScanSection } from "./epub-book";

function docOf(body: string): Document {
  return new DOMParser().parseFromString(`<html><body>${body}</body></html>`, "text/html");
}

describe("scanSectionTextProfiles", () => {
  it("adapts epubjs load/document/unload and can load again after the scan", async () => {
    const doc = docOf("<div>Reloadable</div>");
    const source = {
      href: "reload.xhtml",
      document: undefined as unknown as Document,
      load: vi.fn(function (this: { document: Document }) {
        this.document = doc;
        return doc;
      }),
      unload: vi.fn(function (this: { document: Document | undefined }) {
        this.document = undefined;
      }),
    };
    const section = adaptTextScanSection(0, source, vi.fn());

    await expect(scanSectionTextProfiles([section], vi.fn())).resolves.toEqual([
      {
        readableLength: 10,
        chapterTextLength: htmlToText(doc.documentElement.outerHTML).length,
      },
    ]);
    expect(source.document).toBeUndefined();

    await expect(section.load()).resolves.toBe(doc);
    expect(source.document).toBe(doc);
    section.unload();
    expect(source.document).toBeUndefined();
  });

  it("scans every spine item in order and unloads each parsed document", async () => {
    const events: string[] = [];
    const sections: TextScanSection[] = [
      {
        href: "front.xhtml",
        load: async () => {
          events.push("load:front");
          return docOf("<h1>Front</h1>");
        },
        unload: () => events.push("unload:front"),
      },
      {
        href: "chapter.xhtml",
        load: async () => {
          events.push("load:chapter");
          return docOf("<p>Chapter text</p><script>ignored</script>");
        },
        unload: () => events.push("unload:chapter"),
      },
    ];

    await expect(scanSectionTextProfiles(sections, vi.fn())).resolves.toEqual([
      {
        readableLength: 5,
        chapterTextLength: htmlToText(docOf("<h1>Front</h1>").documentElement.outerHTML).length,
      },
      {
        readableLength: 12,
        chapterTextLength: htmlToText(
          docOf("<p>Chapter text</p><script>ignored</script>").documentElement.outerHTML,
        ).length,
      },
    ]);
    expect(events).toEqual(["load:front", "unload:front", "load:chapter", "unload:chapter"]);
  });

  it("uses zero for a failed item, reports it, and continues scanning", async () => {
    const error = new Error("broken XHTML");
    const unload = vi.fn();
    const warning = vi.fn();
    const sections: TextScanSection[] = [
      {
        href: "broken.xhtml",
        load: async () => {
          throw error;
        },
        unload,
      },
      {
        href: "good.xhtml",
        load: async () => docOf("<p>Good</p>"),
        unload: vi.fn(),
      },
    ];

    await expect(scanSectionTextProfiles(sections, warning)).resolves.toEqual([
      { readableLength: 0, chapterTextLength: 0 },
      {
        readableLength: 4,
        chapterTextLength: htmlToText(docOf("<p>Good</p>").documentElement.outerHTML).length,
      },
    ]);
    expect(warning).toHaveBeenCalledWith({ index: 0, href: "broken.xhtml", error });
    expect(unload).toHaveBeenCalledOnce();
  });
});
