// src/main/ai/finish-feedback.test.ts
import { beforeAll, describe, expect, it } from "vitest";
import { initMainI18n } from "@main/i18n";
import { finishFeedback } from "@main/ai/finish-feedback";

beforeAll(() => initMainI18n("en"));

describe("finishFeedback", () => {
  it.each([
    ["length", "truncated"],
    ["content-filter", "content-filtered"],
    ["error", "provider-error"],
  ] as const)("reports %s as %s", (finishReason, code) => {
    expect(finishFeedback({ finishReason, rawFinishReason: undefined })?.code).toBe(code);
  });

  it.each(["stop", "tool-calls", "other"] as const)("stays silent for %s", (finishReason) => {
    expect(finishFeedback({ finishReason, rawFinishReason: "whatever" })).toBeNull();
  });

  it("quotes the provider's raw reason in a provider error", () => {
    const feedback = finishFeedback({
      finishReason: "error",
      rawFinishReason: "insufficient_system_resource",
    });
    expect(feedback?.message).toContain("insufficient_system_resource");
  });

  it("gives a provider error a readable message without a raw reason", () => {
    const feedback = finishFeedback({ finishReason: "error", rawFinishReason: undefined });
    expect(feedback?.message).toBe("The model provider reported an error and stopped the reply.");
  });
});
