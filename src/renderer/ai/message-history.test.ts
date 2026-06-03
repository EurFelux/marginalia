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
  it("maps id/role/parts and omits metadata (MVP: no chip re-render)", () => {
    expect(messageDtoToUIMessage(dto)).toEqual({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "你好" }],
    });
  });
  it("messagesToUI maps a list in order", () => {
    expect(messagesToUI([dto, { ...dto, id: "m2", role: "assistant" }]).map((m) => m.id)).toEqual([
      "m1",
      "m2",
    ]);
  });
});
