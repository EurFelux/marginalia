import { PDFDocument, PDFName } from "pdf-lib";
import { describe, expect, it } from "vitest";
import { makeScannedPdf, makeTextPdf } from "./fixture";

const PDF_MAGIC = [0x25, 0x50, 0x44, 0x46, 0x2d]; // %PDF-

describe("pdf fixtures", () => {
  it("makeTextPdf produces a PDF byte stream", async () => {
    const bytes = await makeTextPdf({ outline: true, title: "Fixture Book" });
    expect(Array.from(bytes.slice(0, 5))).toEqual(PDF_MAGIC);
    expect(bytes.length).toBeGreaterThan(500);
  });

  it("makeScannedPdf produces a PDF byte stream", async () => {
    const bytes = await makeScannedPdf();
    expect(Array.from(bytes.slice(0, 5))).toEqual(PDF_MAGIC);
  });

  it("makeTextPdf outline=true writes /Outlines to catalog", async () => {
    const bytes = await makeTextPdf({ outline: true, title: "Fixture Book" });
    // pdf-lib 能 round-trip 自己的产物：直接验证 outline 确实挂上了 catalog
    const doc = await PDFDocument.load(bytes);
    expect(doc.catalog.get(PDFName.of("Outlines"))).toBeDefined();
  });

  it("makeScannedPdf produces 3 pages", async () => {
    const doc = await PDFDocument.load(await makeScannedPdf());
    expect(doc.getPageCount()).toBe(3);
  });
});
