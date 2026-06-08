import { describe, expect, it } from "vitest";
import { nextAssistantId } from "@renderer/ai/chat-actions";
import type { ChatUIMessage } from "@renderer/ai/types";

const u = (id: string): ChatUIMessage => ({
  id,
  role: "user",
  parts: [{ type: "text", text: "q" }],
});
const a = (id: string): ChatUIMessage => ({
  id,
  role: "assistant",
  parts: [{ type: "text", text: "r" }],
});

describe("nextAssistantId", () => {
  it("returns the assistant immediately following the user message", () => {
    expect(nextAssistantId([u("u1"), a("a1"), u("u2"), a("a2")], "u1")).toBe("a1");
    expect(nextAssistantId([u("u1"), a("a1"), u("u2"), a("a2")], "u2")).toBe("a2");
  });
  it("returns undefined when the user message has no following assistant", () => {
    expect(nextAssistantId([u("u1"), a("a1"), u("u2")], "u2")).toBeUndefined();
  });
  it("returns undefined for an unknown id", () => {
    expect(nextAssistantId([u("u1"), a("a1")], "nope")).toBeUndefined();
  });
});
