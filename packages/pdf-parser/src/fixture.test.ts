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
});
