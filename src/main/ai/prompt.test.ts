// src/main/ai/prompt.test.ts
import { describe, expect, it } from "vitest";
import { assemblePrompt, type PromptHistoryMessage } from "@main/ai/prompt";
import type { Chip } from "@shared/chat";

function userChips(selection: string, paragraph?: string): Chip[] {
  const chips: Chip[] = [
    {
      id: "selection",
      labelKey: "chip.selection",
      content: selection,
      tokenCount: 1,
      required: true,
      enabled: true,
    },
  ];
  if (paragraph) {
    chips.push({
      id: "paragraph",
      labelKey: "chip.paragraph",
      content: paragraph,
      tokenCount: 1,
      required: true,
      enabled: true,
    });
  }
  return chips;
}

describe("assemblePrompt", () => {
  it("puts the assistant system prompt first when present", () => {
    const out = assemblePrompt({
      systemPrompt: "You are helpful.",
      chapter: null,
      history: [],
      current: { chips: userChips("sel"), userText: "explain" },
    });
    expect(out[0]).toEqual({ role: "system", content: "You are helpful." });
  });

  it("omits the system message when systemPrompt is null", () => {
    const out = assemblePrompt({
      systemPrompt: null,
      chapter: null,
      history: [],
      current: { chips: userChips("sel"), userText: "explain" },
    });
    expect(out.every((m) => m.role !== "system")).toBe(true);
  });

  it("renders the current user turn with chapter summary, context and selection", () => {
    const out = assemblePrompt({
      systemPrompt: null,
      chapter: { title: "Chapter One", summary: "It begins." },
      history: [],
      current: {
        chips: userChips("the cat", "the cat sat on the mat"),
        userText: "what does this mean?",
      },
    });
    const last = out[out.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe(
      "## 本章概要：Chapter One\nIt begins.\n\n" +
        "## 周围上下文\nthe cat sat on the mat\n\n" +
        "## 选中文本\nthe cat\n\n" +
        "what does this mean?",
    );
  });

  it("omits the chapter section when chapter is null and the paragraph when absent", () => {
    const out = assemblePrompt({
      systemPrompt: null,
      chapter: null,
      history: [],
      current: { chips: userChips("only selection"), userText: "hi" },
    });
    expect(out[out.length - 1].content).toBe("## 选中文本\nonly selection\n\nhi");
  });

  it("re-expands each historical user turn from its own metadata chips, without chapter summary", () => {
    const history: PromptHistoryMessage[] = [
      {
        role: "user",
        parts: [{ type: "text", text: "earlier question" }],
        metadata: {
          contextChips: [
            { id: "selection", content: "old sel", tokenCount: 1 },
            { id: "paragraph", content: "old para", tokenCount: 1 },
          ],
        },
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "earlier answer" }],
        metadata: null,
      },
    ];
    const out = assemblePrompt({
      systemPrompt: "sys",
      chapter: { title: null, summary: "current summary" },
      history,
      current: { chips: userChips("new sel"), userText: "follow up" },
    });
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    expect(out[1]).toEqual({
      role: "user",
      content: "## 周围上下文\nold para\n\n## 选中文本\nold sel\n\nearlier question",
    });
    expect(out[2]).toEqual({ role: "assistant", content: "earlier answer" });
    // 章节摘要（无标题 → 仅「## 本章概要」）只出现在当前轮
    expect(out[3].content).toBe(
      "## 本章概要\ncurrent summary\n\n## 选中文本\nnew sel\n\nfollow up",
    );
  });
});
