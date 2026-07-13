import { describe, expect, it } from "vitest";
import { assistantActivity } from "@renderer/ai/assistant-activity";
import type { ChatUIMessage } from "@renderer/ai/types";

type Part = ChatUIMessage["parts"][number];

const reasoning = (state: "streaming" | "done", text = "SECRET_CHAIN_OF_THOUGHT"): Part => ({
  type: "reasoning",
  text,
  state,
});

const text = (value: string): Part => ({ type: "text", text: value });

const tool = (state: "input-available" | "output-available"): Part =>
  ({
    type: "tool-readPage",
    toolCallId: "call-1",
    state,
    input: { page: 1 },
    ...(state === "output-available"
      ? { output: { kind: "text", page: 1, text: "page contents" } }
      : {}),
  }) as Part;

const stepStart = { type: "step-start" } as Part;

describe("assistantActivity", () => {
  it("shows preparing immediately after submission", () => {
    expect(assistantActivity("submitted", undefined)).toBe("preparing");
  });

  it("shows preparing for structural-only streaming", () => {
    expect(assistantActivity("streaming", [stepStart, text("")])).toBe("preparing");
  });

  it("shows reasoning while the reasoning part is streaming", () => {
    expect(assistantActivity("streaming", [reasoning("streaming")])).toBe("reasoning");
  });

  it("returns to preparing when reasoning finishes before the next part arrives", () => {
    expect(assistantActivity("streaming", [reasoning("done")])).toBe("preparing");
  });

  it("does not derive anything from reasoning text", () => {
    expect(assistantActivity("streaming", [reasoning("streaming", "first secret")])).toBe(
      assistantActivity("streaming", [reasoning("streaming", "different secret")]),
    );
  });

  it("lets a later tool row take over", () => {
    expect(assistantActivity("streaming", [reasoning("done"), tool("input-available")])).toBe(null);
  });

  it("shows preparing after a completed tool while waiting for the next model chunk", () => {
    expect(assistantActivity("streaming", [reasoning("done"), tool("output-available")])).toBe(
      "preparing",
    );
  });

  it("shows later reasoning below a completed tool row", () => {
    expect(
      assistantActivity("streaming", [
        reasoning("done"),
        tool("output-available"),
        reasoning("streaming"),
      ]),
    ).toBe("reasoning");
  });

  it("lets answer text take over", () => {
    expect(assistantActivity("streaming", [reasoning("done"), text("Answer")])).toBe(null);
  });

  it.each(["ready", "error"] as const)("hides activity when chat is %s", (status) => {
    expect(assistantActivity(status, [reasoning("streaming")])).toBe(null);
  });
});
