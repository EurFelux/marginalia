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
});
