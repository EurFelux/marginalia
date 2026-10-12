import { describe, expect, it } from "vitest";
import { isBlockedWhileReplying, planSelectionAction } from "@renderer/ai/ai-action-draft";

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

describe("isBlockedWhileReplying", () => {
  it("blocks only auto-send actions, and only while the AI is replying", () => {
    expect(isBlockedWhileReplying({ autoSend: true }, true)).toBe(true);
    expect(isBlockedWhileReplying({ autoSend: false }, true)).toBe(false);
    expect(isBlockedWhileReplying({ autoSend: true }, false)).toBe(false);
  });
});
