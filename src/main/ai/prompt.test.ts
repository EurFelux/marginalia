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
      state: "required",
    },
  ];
  if (paragraph) {
    chips.push({
      id: "paragraph",
      labelKey: "chip.paragraph",
      content: paragraph,
      tokenCount: 1,
      state: "required",
    });
  }
  return chips;
}

describe("assemblePrompt", () => {
  it("puts the assistant system prompt first when present", () => {
    const out = assemblePrompt({
      systemPrompt: "You are helpful.",
      history: [],
      current: { chips: userChips("sel"), userText: "explain" },
    });
    expect(out[0]).toEqual({ role: "system", content: "You are helpful." });
  });

  it("omits the system message when systemPrompt is null", () => {
    const out = assemblePrompt({
      systemPrompt: null,
      history: [],
      current: { chips: userChips("sel"), userText: "explain" },
    });
    expect(out.every((m) => m.role !== "system")).toBe(true);
  });

  it("renders the current user turn with selection and paragraph chips", () => {
    const out = assemblePrompt({
      systemPrompt: null,
      history: [],
      current: {
        chips: userChips("the cat", "the cat sat on the mat"),
        userText: "what does this mean?",
      },
    });
    const last = out[out.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe(
      "## 周围上下文\nthe cat sat on the mat\n\n" +
        "## 选中文本\nthe cat\n\n" +
        "what does this mean?",
    );
  });

  it("omits the paragraph section when absent", () => {
    const out = assemblePrompt({
      systemPrompt: null,
      history: [],
      current: { chips: userChips("only selection"), userText: "hi" },
    });
    expect(out[out.length - 1].content).toBe("## 选中文本\nonly selection\n\nhi");
  });

  it("renders chapter-summary chip in current turn", () => {
    const chips: Chip[] = [
      {
        id: "chapter-summary",
        labelKey: "chip.chapterSummary",
        content: "本章讲了 X",
        tokenCount: 1,
        state: "on",
      },
      ...userChips("the cat"),
    ];
    const out = assemblePrompt({
      systemPrompt: null,
      history: [],
      current: { chips, userText: "explain" },
    });
    expect(out[out.length - 1].content).toContain("## 本章概要\n本章讲了 X");
  });

  it("renders book-summary chip in current turn", () => {
    const chips: Chip[] = [
      {
        id: "book-summary",
        labelKey: "chip.bookSummary",
        content: "这本书讲了 Y",
        tokenCount: 1,
        state: "on",
      },
      ...userChips("the cat"),
    ];
    const out = assemblePrompt({
      systemPrompt: null,
      history: [],
      current: { chips, userText: "explain" },
    });
    expect(out[out.length - 1].content).toContain("## 全书概要\n这本书讲了 Y");
  });

  it("renders all four sections in fixed order: book-summary → chapter-summary → paragraph → selection → userText", () => {
    const chips: Chip[] = [
      {
        id: "book-summary",
        labelKey: "chip.bookSummary",
        content: "B",
        tokenCount: 1,
        state: "on",
      },
      {
        id: "chapter-summary",
        labelKey: "chip.chapterSummary",
        content: "C",
        tokenCount: 1,
        state: "on",
      },
      {
        id: "paragraph",
        labelKey: "chip.paragraph",
        content: "P",
        tokenCount: 1,
        state: "required",
      },
      {
        id: "selection",
        labelKey: "chip.selection",
        content: "S",
        tokenCount: 1,
        state: "required",
      },
    ];
    const out = assemblePrompt({
      systemPrompt: null,
      history: [],
      current: { chips, userText: "Q" },
    });
    expect(out[out.length - 1].content).toBe(
      `## 全书概要\nB\n\n## 本章概要\nC\n\n## 周围上下文\nP\n\n## 选中文本\nS\n\nQ`,
    );
  });

  it("re-expands each historical user turn from its own metadata chips (isomorphic with current turn)", () => {
    const history: PromptHistoryMessage[] = [
      {
        role: "user",
        parts: [{ type: "text", text: "earlier question" }],
        metadata: {
          contextChips: [
            { id: "chapter-summary", content: "历史章节摘要", tokenCount: 1 },
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
      history,
      current: { chips: userChips("new sel"), userText: "follow up" },
    });
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    // 历史 user 轮应同构渲染：chapter-summary chip 在历史轮中也展开
    expect(out[1]).toEqual({
      role: "user",
      content:
        "## 本章概要\n历史章节摘要\n\n## 周围上下文\nold para\n\n## 选中文本\nold sel\n\nearlier question",
    });
    expect(out[2]).toEqual({ role: "assistant", content: "earlier answer" });
    // 当前轮
    expect(out[3].content).toBe("## 选中文本\nnew sel\n\nfollow up");
  });
});
