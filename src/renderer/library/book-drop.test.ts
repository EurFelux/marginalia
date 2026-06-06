import { describe, expect, it } from "vitest";
import { fileNameOf, isFilesDrag, pickBookFiles } from "./book-drop";

describe("isFilesDrag", () => {
  it("returns true when the drag payload includes external files", () => {
    expect(isFilesDrag(["Files"])).toBe(true);
  });
  it("returns false for text/internal drags and empty payloads", () => {
    expect(isFilesDrag(["text/plain"])).toBe(false);
    expect(isFilesDrag([])).toBe(false);
  });
});

describe("pickBookFiles", () => {
  const names = (files: { name: string }[]) => files.map((f) => f.name);

  it("keeps .epub and .pdf in books, the rest in ignored", () => {
    const { books, ignored } = pickBookFiles([
      { name: "a.epub" },
      { name: "b.pdf" },
      { name: "c.txt" },
      { name: "d.epub" },
    ]);
    expect(names(books)).toEqual(["a.epub", "b.pdf", "d.epub"]);
    expect(names(ignored)).toEqual(["c.txt"]);
  });
  it("matches extensions case-insensitively", () => {
    expect(names(pickBookFiles([{ name: "Book.EPUB" }]).books)).toEqual(["Book.EPUB"]);
    expect(names(pickBookFiles([{ name: "Doc.PDF" }]).books)).toEqual(["Doc.PDF"]);
  });
  it(".pdf lands in books and .txt in ignored", () => {
    const { books, ignored } = pickBookFiles([{ name: "scan.pdf" }, { name: "notes.txt" }]);
    expect(names(books)).toEqual(["scan.pdf"]);
    expect(names(ignored)).toEqual(["notes.txt"]);
  });
  it("treats folders (no extension) as ignored", () => {
    const { books, ignored } = pickBookFiles([{ name: "MyFolder" }]);
    expect(books).toEqual([]);
    expect(names(ignored)).toEqual(["MyFolder"]);
  });
  it("returns empty groups for an empty list", () => {
    expect(pickBookFiles([])).toEqual({ books: [], ignored: [] });
  });
  it("preserves input order", () => {
    expect(names(pickBookFiles([{ name: "2.epub" }, { name: "1.pdf" }]).books)).toEqual([
      "2.epub",
      "1.pdf",
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
