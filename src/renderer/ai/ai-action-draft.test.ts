import { describe, expect, it } from "vitest";
import { planSelectionAction } from "@renderer/ai/ai-action-draft";

describe("planSelectionAction", () => {
  it("keeps the existing draft when there is no prompt (Ask without a written prompt)", () => {
    expect(planSelectionAction({ prompt: "", autoSend: false })).toBe("keepDraft");
    expect(planSelectionAction({ prompt: "  ", autoSend: false })).toBe("keepDraft");
  });

  it("fills the draft with the prompt when auto-send is off", () => {
    expect(planSelectionAction({ prompt: "Explain.", autoSend: false })).toBe("fill");
  });

  it("sends right away when auto-send is on", () => {
    expect(planSelectionAction({ prompt: "Explain.", autoSend: true })).toBe("send");
  });
});
