import { unzipSync } from "fflate";
import { describe, expect, it } from "vitest";
import { makeFixtureEpub } from "./fixture";

describe("makeFixtureEpub", () => {
  it("produces a zip with the expected entries", () => {
    const files = unzipSync(makeFixtureEpub());
    expect(Object.keys(files).sort()).toEqual(
      [
        "META-INF/container.xml",
        "OEBPS/ch1.xhtml",
        "OEBPS/ch2.xhtml",
        "OEBPS/content.opf",
        "OEBPS/cover.png",
        "OEBPS/nav.xhtml",
        "mimetype",
      ].sort(),
    );
  });
});
