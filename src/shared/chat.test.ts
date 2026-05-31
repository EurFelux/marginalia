// src/shared/chat.test.ts
import { describe, expect, it } from "vitest";
import {
  buildChipsInput,
  chipSchema,
  createConversationInput,
  messagesByConversationInput,
} from "@shared/chat";

describe("chat schemas", () => {
  it("chipSchema accepts a well-formed selection chip", () => {
    const chip = {
      id: "selection",
      labelKey: "chip.selection",
      content: "hello",
      tokenCount: 2,
      required: true,
      enabled: true,
    };
    expect(chipSchema.parse(chip)).toEqual(chip);
  });

  it("chipSchema rejects an unknown chip id", () => {
    const r = chipSchema.safeParse({
      id: "chapter",
      labelKey: "x",
      content: "y",
      tokenCount: 0,
      required: true,
      enabled: true,
    });
    expect(r.success).toBe(false);
  });

  it("chipSchema rejects a negative tokenCount", () => {
    const r = chipSchema.safeParse({
      id: "selection",
      labelKey: "x",
      content: "y",
      tokenCount: -1,
      required: true,
      enabled: true,
    });
    expect(r.success).toBe(false);
  });

  it("buildChipsInput requires a non-empty selection and current paragraph", () => {
    expect(buildChipsInput.safeParse({ selection: "", paragraphCurrent: "p" }).success).toBe(false);
    expect(buildChipsInput.safeParse({ selection: "s", paragraphCurrent: "p" }).success).toBe(true);
  });

  it("createConversationInput allows a null chapterId (independent conversation)", () => {
    expect(createConversationInput.safeParse({ bookId: "b", chapterId: null }).success).toBe(true);
    expect(createConversationInput.safeParse({ bookId: "", chapterId: null }).success).toBe(false);
  });

  it("messagesByConversationInput requires a non-empty conversationId", () => {
    expect(messagesByConversationInput.safeParse({ conversationId: "" }).success).toBe(false);
    expect(messagesByConversationInput.safeParse({ conversationId: "c" }).success).toBe(true);
  });
});
