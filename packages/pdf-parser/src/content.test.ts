import { describe, expect, it } from "vitest";
import { extractPdfText } from "./content";
import { makeTextPdf } from "./fixture";

describe("extractPdfText", () => {
  it("extracts page range with page-boundary markers", async () => {
    const bytes = await makeTextPdf({ outline: false });
    const slice = await extractPdfText(bytes, { startPage: 1, endPage: 2 });
    expect(slice.text).toContain("[p.1]");
    expect(slice.text).toContain("[p.2]");
    expect(slice.text).not.toContain("[p.3]");
    // fixture 正文按词渲染，提取后空白形态可能不同——按词序片段断言
    expect(slice.text).toContain("body text of page 1");
    expect(slice.hasMore).toBe(false);
  });

  it("paginates by character offset", async () => {
    const bytes = await makeTextPdf({ outline: false });
    const first = await extractPdfText(bytes, { startPage: 1, endPage: 3, maxChars: 80 });
    expect(first.text.length).toBe(80);
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(80);
    const rest = await extractPdfText(bytes, {
      startPage: 1,
      endPage: 3,
      offset: first.nextOffset,
      maxChars: 100_000,
    });
    expect(rest.hasMore).toBe(false);
    // 拼回完整文本：与一次性读取一致
    const whole = await extractPdfText(bytes, { startPage: 1, endPage: 3, maxChars: 100_000 });
    expect(first.text + rest.text).toBe(whole.text);
  });
});
