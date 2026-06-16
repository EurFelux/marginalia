// src/main/ai/prompt.test.ts
import { describe, expect, it } from "vitest";
import {
  assemblePrompt,
  formatCurrentDateTime,
  pdfSystemNote,
  renderHistoryMessage,
  renderRoleTaggedTranscript,
  renderWebSearchHint,
  type PromptHistoryMessage,
} from "@main/ai/prompt";
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
  it("puts the assistant system prompt first when present", async () => {
    const out = await assemblePrompt({
      systemPrompt: "You are helpful.",
      history: [],
      current: { chips: userChips("sel"), userText: "explain" },
    });
    expect(out[0]).toEqual({ role: "system", content: "You are helpful." });
  });

  it("omits the system message when systemPrompt is null", async () => {
    const out = await assemblePrompt({
      systemPrompt: null,
      history: [],
      current: { chips: userChips("sel"), userText: "explain" },
    });
    expect(out.every((m) => m.role !== "system")).toBe(true);
  });

  it("renders the current user turn with selection and paragraph chips", async () => {
    const out = await assemblePrompt({
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

  it("omits the paragraph section when absent", async () => {
    const out = await assemblePrompt({
      systemPrompt: null,
      history: [],
      current: { chips: userChips("only selection"), userText: "hi" },
    });
    expect(out[out.length - 1].content).toBe("## 选中文本\nonly selection\n\nhi");
  });

  it("renders chapter-summary chip in current turn", async () => {
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
    const out = await assemblePrompt({
      systemPrompt: null,
      history: [],
      current: { chips, userText: "explain" },
    });
    expect(out[out.length - 1].content).toContain("## 本章概要\n本章讲了 X");
  });

  it("renders book-summary chip in current turn", async () => {
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
    const out = await assemblePrompt({
      systemPrompt: null,
      history: [],
      current: { chips, userText: "explain" },
    });
    expect(out[out.length - 1].content).toContain("## 全书概要\n这本书讲了 Y");
  });

  it("renders all four sections in fixed order: book-summary → chapter-summary → paragraph → selection → userText", async () => {
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
    const out = await assemblePrompt({
      systemPrompt: null,
      history: [],
      current: { chips, userText: "Q" },
    });
    expect(out[out.length - 1].content).toBe(
      `## 全书概要\nB\n\n## 本章概要\nC\n\n## 周围上下文\nP\n\n## 选中文本\nS\n\nQ`,
    );
  });

  it("renders current PDF page with direct readPage params", async () => {
    const out = await assemblePrompt({
      systemPrompt: null,
      history: [],
      current: {
        chips: [],
        userText: "what am I reading?",
        readingContext: {
          format: "pdf",
          page: 42,
          pageCount: 300,
          chapterId: "ch-1",
          chapterTitle: "Middle",
        },
      },
    });
    expect(out[out.length - 1].content).toContain("PDF page 42 of 300");
    expect(out[out.length - 1].content).toContain('readPage with {"page":42,"mode":"text"}');
  });

  it("renders current ePub chapter with direct readChapterText params", async () => {
    const out = await assemblePrompt({
      systemPrompt: null,
      history: [],
      current: {
        chips: [],
        userText: "what am I reading?",
        readingContext: {
          format: "epub",
          chapterId: "ch-epub",
          chapterTitle: "Opening",
          offset: 1234,
          maxChars: 4000,
          spineIndex: 3,
        },
      },
    });
    expect(out[out.length - 1].content).toContain("ePub chapterId: ch-epub (Opening)");
    expect(out[out.length - 1].content).toContain("Estimated chapter text offset: 1234");
    expect(out[out.length - 1].content).toContain(
      'readChapterText with {"chapterId":"ch-epub","offset":1234,"maxChars":4000}',
    );
  });

  it("replays an assistant tool-call/result turn as structured assistant + tool messages", async () => {
    const history: PromptHistoryMessage[] = [
      { role: "user", parts: [{ type: "text", text: "what's on page 3?" }], metadata: null },
      {
        role: "assistant",
        parts: [
          { type: "text", text: "Let me check." },
          {
            type: "tool-readChapterText",
            toolCallId: "c1",
            state: "output-available",
            input: { chapterId: "ch-1" },
            output: { text: "verbatim chapter text", hasMore: false },
          },
          { type: "text", text: "It discusses cats." },
        ] as PromptHistoryMessage["parts"],
        metadata: null,
      },
    ];
    const out = await assemblePrompt({
      systemPrompt: null,
      history,
      current: { chips: [], userText: "go on" },
    });
    const assistant = out.find((m) => m.role === "assistant");
    const toolMsg = out.find((m) => m.role === "tool");
    expect(assistant).toBeDefined();
    expect(toolMsg).toBeDefined();
    const aContent = assistant!.content as Array<{
      type: string;
      toolName?: string;
      text?: string;
    }>;
    expect(aContent.some((p) => p.type === "text" && p.text === "Let me check.")).toBe(true);
    expect(aContent.some((p) => p.type === "tool-call" && p.toolName === "readChapterText")).toBe(
      true,
    );
    const tContent = toolMsg!.content as Array<{
      type: string;
      toolName?: string;
      output?: unknown;
    }>;
    expect(tContent.some((p) => p.type === "tool-result" && p.toolName === "readChapterText")).toBe(
      true,
    );
  });

  it("re-expands each historical user turn from its own metadata chips (isomorphic with current turn)", async () => {
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
    const out = await assemblePrompt({
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
    expect(out[2]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "earlier answer" }],
    });
    // 当前轮
    expect(out[3].content).toBe("## 选中文本\nnew sel\n\nfollow up");
  });

  it("elides a readPage image tool-result to a placeholder (no base64 replayed)", async () => {
    const out = await assemblePrompt({
      systemPrompt: null,
      history: [
        {
          role: "assistant",
          parts: [
            { type: "text", text: "Here is the page." },
            {
              type: "tool-readPage",
              toolCallId: "img1",
              state: "output-available",
              input: { page: 3, mode: "image" },
              output: { kind: "image", page: 3, data: "BASE64BLOBSHOULDNOTAPPEAR" },
            },
          ] as PromptHistoryMessage["parts"],
          metadata: null,
        },
      ],
      current: { chips: [], userText: "next" },
    });
    const dump = JSON.stringify(out);
    expect(dump).not.toContain("BASE64BLOBSHOULDNOTAPPEAR");
    expect(dump).toContain("[page 3 image omitted from history]");
  });

  it("drops cross-turn reasoning parts from replayed history", async () => {
    const out = await assemblePrompt({
      systemPrompt: null,
      history: [
        {
          role: "assistant",
          parts: [
            { type: "reasoning", text: "SECRET_CHAIN_OF_THOUGHT", state: "done" },
            { type: "text", text: "answer" },
          ] as PromptHistoryMessage["parts"],
          metadata: null,
        },
      ],
      current: { chips: [], userText: "next" },
    });
    expect(JSON.stringify(out)).not.toContain("SECRET_CHAIN_OF_THOUGHT");
  });

  it("drops an orphan tool-call (no result) without throwing", async () => {
    const out = await assemblePrompt({
      systemPrompt: null,
      history: [
        {
          role: "assistant",
          parts: [
            { type: "text", text: "partial" },
            {
              type: "tool-readPage",
              toolCallId: "orphan",
              state: "input-available",
              input: { page: 9, mode: "text" },
            },
          ] as PromptHistoryMessage["parts"],
          metadata: null,
        },
      ],
      current: { chips: [], userText: "next" },
    });
    expect(out.some((m) => m.role === "tool")).toBe(false);
    expect(JSON.stringify(out)).toContain("partial");
  });

  it("keeps a plain text assistant turn equivalent (regression)", async () => {
    const out = await assemblePrompt({
      systemPrompt: null,
      history: [
        { role: "assistant", parts: [{ type: "text", text: "just text" }], metadata: null },
      ],
      current: { chips: [], userText: "next" },
    });
    expect(
      out.some((m) => m.role === "assistant" && JSON.stringify(m.content).includes("just text")),
    ).toBe(true);
    expect(out.some((m) => m.role === "tool")).toBe(false);
  });

  it("replays a failed (output-error) tool call as a tool result without throwing", async () => {
    const out = await assemblePrompt({
      systemPrompt: null,
      history: [
        {
          role: "assistant",
          parts: [
            { type: "text", text: "trying" },
            {
              type: "tool-readPage",
              toolCallId: "e1",
              state: "output-error",
              input: { page: 99, mode: "text" },
              errorText: "page 99 is out of range",
            },
          ] as PromptHistoryMessage["parts"],
          metadata: null,
        },
      ],
      current: { chips: [], userText: "next" },
    });
    const toolMsg = out.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(JSON.stringify(toolMsg!.content)).toContain("page 99 is out of range");
  });

  it("injects the current date/time into the live user turn when provided", async () => {
    const out = await assemblePrompt({
      systemPrompt: "sys",
      history: [],
      current: {
        chips: [],
        userText: "what year is it?",
        currentDateTime: "2026-06-16T14:30:05+08:00",
      },
    });
    const last = out[out.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toContain("## Current date and time\n2026-06-16T14:30:05+08:00");
    // It is environment context for THIS turn, never the cached system prefix.
    expect(out[0].content).not.toContain("Current date and time");
  });

  it("omits the date/time section when currentDateTime is absent", async () => {
    const out = await assemblePrompt({
      systemPrompt: null,
      history: [],
      current: { chips: [], userText: "hi" },
    });
    expect(out[out.length - 1].content).toBe("hi");
  });

  it("places date/time before reading position and chips in the live turn", async () => {
    const out = await assemblePrompt({
      systemPrompt: null,
      history: [],
      current: {
        chips: userChips("the cat"),
        userText: "Q",
        currentDateTime: "2026-06-16T14:30:05+08:00",
        readingContext: {
          format: "pdf",
          page: 1,
          pageCount: 10,
          chapterId: "c",
          chapterTitle: "T",
        },
      },
    });
    const c = out[out.length - 1].content as string;
    expect(c.indexOf("Current date and time")).toBeLessThan(c.indexOf("Current reading position"));
    expect(c.indexOf("Current reading position")).toBeLessThan(c.indexOf("选中文本"));
  });
});

describe("pdfSystemNote", () => {
  it("mentions page count and readPage for text-layer pdfs", () => {
    const s = pdfSystemNote({ pageCount: 270, hasTextLayer: true, imageMode: false });
    expect(s).toContain("PDF");
    expect(s).toContain("270 pages");
    expect(s).toContain("readPage");
    expect(s).toContain("[p.N]");
    expect(s).not.toContain('"image"');
  });
  it("advertises image mode when gated on", () => {
    const s = pdfSystemNote({ pageCount: 10, hasTextLayer: true, imageMode: true });
    expect(s).toContain('mode "image"');
  });
  it("tells the truth about scanned pdfs", () => {
    const s = pdfSystemNote({ pageCount: null, hasTextLayer: false, imageMode: true });
    expect(s).toContain("scanned");
    expect(s).not.toContain("[p.N]");
  });
});

describe("renderHistoryMessage", () => {
  it("renders an assistant turn as its text parts only", () => {
    expect(
      renderHistoryMessage({
        role: "assistant",
        parts: [
          { type: "reasoning", text: "ignored", state: "done" },
          { type: "text", text: "hello" },
        ],
        metadata: null,
      }),
    ).toBe("hello");
  });

  it("renders a user turn with its chip sections then the text", () => {
    const out = renderHistoryMessage({
      role: "user",
      parts: [{ type: "text", text: "why?" }],
      metadata: { contextChips: [{ id: "selection", content: "the cat", tokenCount: 1 }] },
    });
    expect(out).toContain("## 选中文本\nthe cat");
    expect(out).toContain("why?");
  });
});

describe("renderRoleTaggedTranscript", () => {
  it("wraps each turn in <user>/<assistant> tags using renderHistoryMessage content", () => {
    const out = renderRoleTaggedTranscript([
      { role: "user", parts: [{ type: "text", text: "hello" }], metadata: null },
      { role: "assistant", parts: [{ type: "text", text: "hi" }], metadata: null },
    ]);
    expect(out).toBe("<user>\nhello\n</user>\n\n<assistant>\nhi\n</assistant>");
  });
});

describe("assemblePrompt priorSummary", () => {
  it("appends the summary to the system message when present", async () => {
    const msgs = await assemblePrompt({
      systemPrompt: "BASE",
      priorSummary: "earlier we discussed X",
      history: [],
      current: { chips: [], userText: "hi" },
    });
    expect(msgs[0]?.role).toBe("system");
    expect(msgs[0]?.content).toContain("BASE");
    expect(msgs[0]?.content).toContain("## Conversation summary so far\nearlier we discussed X");
  });

  it("leaves the system message unchanged when priorSummary is null", async () => {
    const msgs = await assemblePrompt({
      systemPrompt: "BASE",
      priorSummary: null,
      history: [],
      current: { chips: [], userText: "hi" },
    });
    expect(msgs[0]?.content).toBe("BASE");
  });

  it("does not inject date/time into the system message even with priorSummary", async () => {
    const msgs = await assemblePrompt({
      systemPrompt: "BASE",
      priorSummary: "S",
      history: [],
      current: { chips: [], userText: "now", currentDateTime: "2026-06-16T14:30:05+08:00" },
    });
    expect(msgs[0]?.content).not.toContain("Current date and time");
  });

  it("only renders the tail history it is given", async () => {
    const msgs = await assemblePrompt({
      systemPrompt: "BASE",
      priorSummary: "S",
      history: [{ role: "assistant", parts: [{ type: "text", text: "kept" }], metadata: null }],
      current: { chips: [], userText: "now" },
    });
    const joined = JSON.stringify(msgs);
    expect(joined).toContain("kept");
    expect(joined).toContain("now");
  });
});

describe("formatCurrentDateTime", () => {
  it("formats a ZonedDateTime as ISO 8601 with offset, to second precision", () => {
    const zdt = Temporal.ZonedDateTime.from("2026-06-16T14:30:05.123+08:00[Asia/Shanghai]");
    expect(formatCurrentDateTime(zdt)).toBe("2026-06-16T14:30:05+08:00");
  });

  it("drops the bracketed time-zone annotation and keeps a UTC offset", () => {
    const zdt = Temporal.ZonedDateTime.from("2026-01-03T09:04:07+00:00[UTC]");
    expect(formatCurrentDateTime(zdt)).toBe("2026-01-03T09:04:07+00:00");
  });
});

describe("renderWebSearchHint", () => {
  it("returns null when true (tool always registered — no injection needed)", () => {
    expect(renderWebSearchHint(true)).toBeNull();
  });
  it("returns a non-repeatable unavailable reminder when false", () => {
    const h = renderWebSearchHint(false);
    expect(h).toMatch(/unavailable/i);
    expect(h).toMatch(/system-reminder/i);
    expect(h).toMatch(/do not mention/i);
  });
  it("returns null when undefined", () => {
    expect(renderWebSearchHint(undefined)).toBeNull();
  });
});

describe("assemblePrompt web search hint", () => {
  it("injects the unavailable reminder only into the last user turn when off", async () => {
    const msgs = await assemblePrompt({
      systemPrompt: "SYS",
      priorSummary: null,
      history: [],
      current: { chips: [], userText: "hello", readingContext: null, webSearchEnabled: false },
    });
    const sys = msgs.find((m) => m.role === "system");
    expect(JSON.stringify(sys ?? {})).not.toMatch(/web search/i);
    expect(JSON.stringify(msgs.at(-1))).toMatch(/unavailable|do not/i);
  });
  it("injects nothing when web search is on (tool registered, no hint)", async () => {
    const msgs = await assemblePrompt({
      systemPrompt: "SYS",
      priorSummary: null,
      history: [],
      current: { chips: [], userText: "hello", readingContext: null, webSearchEnabled: true },
    });
    expect(JSON.stringify(msgs)).not.toMatch(/system-reminder/i);
  });
});
