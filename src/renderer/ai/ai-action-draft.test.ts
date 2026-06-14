import { describe, expect, it } from "vitest";
import { presetDraftText } from "@renderer/ai/ai-action-draft";

const resolve = (preset: string) => `prompt:${preset}`;

describe("presetDraftText", () => {
  it("keeps the existing draft (returns null) for the generic ask-AI action", () => {
    // 「AI 问」（无 preset）：不得覆盖用户已输入的文字 → 返回 null 表示保留
    expect(presetDraftText(null, resolve)).toBeNull();
  });

  it("overwrites the draft with the resolved preset prompt", () => {
    expect(presetDraftText("explain", resolve)).toBe("prompt:explain");
    expect(presetDraftText("translate", resolve)).toBe("prompt:translate");
    expect(presetDraftText("summarize", resolve)).toBe("prompt:summarize");
  });
});
