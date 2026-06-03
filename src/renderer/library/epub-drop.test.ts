import { describe, expect, it } from "vitest";
import { fileNameOf, isFilesDrag, pickEpubFiles } from "./epub-drop";

describe("isFilesDrag", () => {
  it("returns true when the drag payload includes external files", () => {
    expect(isFilesDrag(["Files"])).toBe(true);
  });
  it("returns false for text/internal drags and empty payloads", () => {
    expect(isFilesDrag(["text/plain"])).toBe(false);
    expect(isFilesDrag([])).toBe(false);
  });
});

describe("pickEpubFiles", () => {
  const names = (files: { name: string }[]) => files.map((f) => f.name);

  it("keeps only .epub in epubs, the rest in ignored", () => {
    const { epubs, ignored } = pickEpubFiles([
      { name: "a.epub" },
      { name: "b.pdf" },
      { name: "c.epub" },
    ]);
    expect(names(epubs)).toEqual(["a.epub", "c.epub"]);
    expect(names(ignored)).toEqual(["b.pdf"]);
  });
  it("matches the .epub extension case-insensitively", () => {
    expect(names(pickEpubFiles([{ name: "Book.EPUB" }]).epubs)).toEqual(["Book.EPUB"]);
  });
  it("treats folders (no extension) as ignored", () => {
    const { epubs, ignored } = pickEpubFiles([{ name: "MyFolder" }]);
    expect(epubs).toEqual([]);
    expect(names(ignored)).toEqual(["MyFolder"]);
  });
  it("returns empty groups for an empty list", () => {
    expect(pickEpubFiles([])).toEqual({ epubs: [], ignored: [] });
  });
  it("preserves input order", () => {
    expect(names(pickEpubFiles([{ name: "2.epub" }, { name: "1.epub" }]).epubs)).toEqual([
      "2.epub",
      "1.epub",
    ]);
  });
});

describe("fileNameOf", () => {
  it("extracts the basename from a posix path", () => {
    expect(fileNameOf("/Users/a/b/Book.epub")).toBe("Book.epub");
  });
  it("extracts the basename from a windows path", () => {
    expect(fileNameOf("C:\\books\\Book.epub")).toBe("Book.epub");
  });
  it("returns the input when there is no separator", () => {
    expect(fileNameOf("Book.epub")).toBe("Book.epub");
  });
});
