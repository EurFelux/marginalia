// src/shared/chat.test.ts
import { describe, expect, it } from "vitest";
import {
  abortInput,
  buildChipsInput,
  chipSchema,
  createConversationInput,
  messagesByConversationInput,
  sendAck,
  sendRequest,
} from "@shared/chat";

describe("chat schemas", () => {
  it("chipSchema accepts a well-formed selection chip", () => {
    const chip = {
      id: "selection",
      labelKey: "chip.selection",
      content: "hello",
      tokenCount: 2,
      state: "required" as const,
    };
    expect(chipSchema.parse(chip)).toEqual(chip);
  });

  it("chipSchema rejects an unknown chip id", () => {
    const r = chipSchema.safeParse({
      id: "chapter",
      labelKey: "x",
      content: "y",
      tokenCount: 0,
      state: "required",
    });
    expect(r.success).toBe(false);
  });

  it("chipSchema rejects a negative tokenCount", () => {
    const r = chipSchema.safeParse({
      id: "selection",
      labelKey: "x",
      content: "y",
      tokenCount: -1,
      state: "required",
    });
    expect(r.success).toBe(false);
  });

  it("chipSchema accepts all three states", () => {
    for (const state of ["required", "on", "off"] as const) {
      expect(
        chipSchema.safeParse({
          id: "chapter-summary",
          labelKey: "chip.chapterSummary",
          content: "x",
          tokenCount: 1,
          state,
        }).success,
      ).toBe(true);
    }
  });

  it("chipSchema rejects legacy boolean / unknown state values", () => {
    for (const state of [true, "enabled", "ON"]) {
      expect(
        chipSchema.safeParse({ id: "selection", labelKey: "x", content: "y", tokenCount: 0, state })
          .success,
      ).toBe(false);
    }
  });

  it("buildChipsInput requires a non-empty selection and current paragraph", () => {
    expect(buildChipsInput.safeParse({ selection: "", paragraphCurrent: "p" }).success).toBe(false);
    expect(buildChipsInput.safeParse({ selection: "s", paragraphCurrent: "p" }).success).toBe(true);
  });

  it("createConversationInput requires a non-empty bookId", () => {
    expect(createConversationInput.safeParse({ bookId: "b" }).success).toBe(true);
    expect(createConversationInput.safeParse({ bookId: "" }).success).toBe(false);
  });

  it("messagesByConversationInput requires a non-empty conversationId", () => {
    expect(messagesByConversationInput.safeParse({ conversationId: "" }).success).toBe(false);
    expect(messagesByConversationInput.safeParse({ conversationId: "c" }).success).toBe(true);
  });
});

describe("sendRequest", () => {
  const base = {
    streamId: "s1",
    bookId: "b1",
    conversationId: "conv-1",
    chips: [],
    userText: "hi",
  };
  it("accepts a valid request with empty chips and explicit conversationId", () => {
    expect(sendRequest.safeParse(base).success).toBe(true);
  });
  it("rejects empty userText", () => {
    expect(sendRequest.safeParse({ ...base, userText: "" }).success).toBe(false);
  });
  it("rejects missing streamId", () => {
    const { streamId: _omit, ...rest } = base;
    expect(sendRequest.safeParse(rest).success).toBe(false);
  });
  it("rejects missing conversationId", () => {
    const { conversationId: _omit, ...rest } = base;
    expect(sendRequest.safeParse(rest).success).toBe(false);
  });
});

describe("sendAck", () => {
  it("accepts ok:true variant", () => {
    expect(sendAck.safeParse({ ok: true, conversationId: "c" }).success).toBe(true);
  });
  it("accepts ok:false variant", () => {
    expect(sendAck.safeParse({ ok: false, reason: "no key" }).success).toBe(true);
  });
});

describe("abortInput", () => {
  it("rejects empty streamId", () => {
    expect(abortInput.safeParse({ streamId: "" }).success).toBe(false);
  });
});
