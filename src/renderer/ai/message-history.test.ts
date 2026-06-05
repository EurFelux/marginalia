import { describe, expect, it } from "vitest";
import type { MessageDto } from "@shared/chat";
import { messageDtoToUIMessage, messagesToUI } from "@renderer/ai/message-history";

const dto: MessageDto = {
  id: "m1",
  conversationId: "c1",
  role: "user",
  parts: [{ type: "text", text: "你好" }],
  metadata: { contextChips: [{ id: "selection", content: "x", tokenCount: 1 }] },
  status: "complete",
  seq: 0,
  createdAt: 1,
};

describe("messageDtoToUIMessage", () => {
  it("hydrates metadata.contextChips back to live chips (labelKey derived from id)", () => {
    expect(messageDtoToUIMessage(dto)).toEqual({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "你好" }],
      metadata: {
        contextChips: [
          {
            id: "selection",
            labelKey: "chip.selection",
            content: "x",
            tokenCount: 1,
            state: "required",
          },
        ],
      },
    });
  });
  it("hydrates paragraph chips with chip.paragraph labelKey", () => {
    const withParagraph: MessageDto = {
      ...dto,
      metadata: { contextChips: [{ id: "paragraph", content: "p", tokenCount: 2 }] },
    };
    expect(messageDtoToUIMessage(withParagraph).metadata?.contextChips).toEqual([
      {
        id: "paragraph",
        labelKey: "chip.paragraph",
        content: "p",
        tokenCount: 2,
        state: "required",
      },
    ]);
  });
  it("hydrates chapter-summary chip with chip.chapterSummary labelKey and state required", () => {
    const withChapterSummary: MessageDto = {
      ...dto,
      metadata: { contextChips: [{ id: "chapter-summary", content: "c", tokenCount: 1 }] },
    };
    expect(messageDtoToUIMessage(withChapterSummary).metadata?.contextChips).toEqual([
      {
        id: "chapter-summary",
        labelKey: "chip.chapterSummary",
        content: "c",
        tokenCount: 1,
        state: "required",
      },
    ]);
  });
  it("hydrates book-summary chip with chip.bookSummary labelKey and state required", () => {
    const withBookSummary: MessageDto = {
      ...dto,
      metadata: { contextChips: [{ id: "book-summary", content: "b", tokenCount: 42 }] },
    };
    expect(messageDtoToUIMessage(withBookSummary).metadata?.contextChips).toEqual([
      {
        id: "book-summary",
        labelKey: "chip.bookSummary",
        content: "b",
        tokenCount: 42,
        state: "required",
      },
    ]);
  });
  it("omits metadata when dto has none (assistant messages / chip-less sends)", () => {
    expect(messageDtoToUIMessage({ ...dto, metadata: null })).toEqual({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "你好" }],
    });
    expect(
      messageDtoToUIMessage({ ...dto, metadata: { contextChips: [] } }).metadata,
    ).toBeUndefined();
  });
  it("messagesToUI maps a list in order", () => {
    expect(messagesToUI([dto, { ...dto, id: "m2", role: "assistant" }]).map((m) => m.id)).toEqual([
      "m1",
      "m2",
    ]);
  });
});
