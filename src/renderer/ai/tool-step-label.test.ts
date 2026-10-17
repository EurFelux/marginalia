// src/renderer/ai/tool-step-label.test.ts
import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { ChapterRefDto } from "@shared/library";
import type { ToolPart } from "@renderer/ai/segments";
import { isErrorShape, toolStepLabel, toolStepStatus } from "@renderer/ai/tool-step-label";

/** stub t：返回 defaultValue 并做 {{var}} 插值，验证 key 选择与参数传递。 */
const t = ((_key: string, defaultValue: string, options?: Record<string, unknown>) => {
  return defaultValue.replace(/\{\{(\w+)\}\}/g, (_m, k: string) => {
    const value = options?.[k];
    if (typeof value === "string" || typeof value === "number") {
      return String(value);
    }
    return `{{${k}}}`;
  });
}) as unknown as TFunction;

const chapter = (over: Partial<ChapterRefDto>): ChapterRefDto => ({
  id: "ch-uuid-1",
  title: "Preface",
  href: "text/preface.xhtml",
  anchor: null,
  orderIndex: 0,
  level: 0,
  startPage: null,
  endPage: null,
  ...over,
});
const chapters = [chapter({})];

const part = (type: string, over: Record<string, unknown> = {}): ToolPart =>
  ({
    type,
    toolCallId: "c1",
    state: "output-available",
    input: {},
    output: {},
    ...over,
  }) as ToolPart;

describe("toolStepLabel", () => {
  it("readPage with page number", () => {
    expect(toolStepLabel(part("tool-readPage", { input: { page: 12 } }), chapters, t)).toBe(
      "读取第 12 页",
    );
  });

  it("readPage falls back when input is partial (streaming)", () => {
    expect(toolStepLabel(part("tool-readPage", { input: undefined }), chapters, t)).toBe(
      "读取页面",
    );
  });

  it("readChapterText resolves chapter by exact id", () => {
    expect(
      toolStepLabel(
        part("tool-readChapterText", { input: { chapterId: "ch-uuid-1" } }),
        chapters,
        t,
      ),
    ).toBe("读取〈Preface〉");
  });

  it("readChapterText resolves chapter by href", () => {
    expect(
      toolStepLabel(
        part("tool-readChapterText", { input: { chapterId: "text/preface.xhtml" } }),
        chapters,
        t,
      ),
    ).toBe("读取〈Preface〉");
  });

  it("readChapterText resolves chapter by unique case-insensitive title", () => {
    expect(
      toolStepLabel(part("tool-readChapterText", { input: { chapterId: "preface" } }), chapters, t),
    ).toBe("读取〈Preface〉");
  });

  it("readChapterText falls back when unresolved or title is null", () => {
    expect(
      toolStepLabel(part("tool-readChapterText", { input: { chapterId: "nope" } }), chapters, t),
    ).toBe("读取章节文本");
    const untitled = [chapter({ title: null })];
    expect(
      toolStepLabel(
        part("tool-readChapterText", { input: { chapterId: "ch-uuid-1" } }),
        untitled,
        t,
      ),
    ).toBe("读取章节文本");
  });

  it("ambiguous title (two matches) falls back", () => {
    const dup = [chapter({}), chapter({ id: "ch-uuid-2", href: "text/p2.xhtml" })];
    expect(
      toolStepLabel(part("tool-readChapterText", { input: { chapterId: "Preface" } }), dup, t),
    ).toBe("读取章节文本");
  });

  it("getChapterSummary with resolved title", () => {
    expect(
      toolStepLabel(
        part("tool-getChapterSummary", { input: { chapterId: "ch-uuid-1" } }),
        chapters,
        t,
      ),
    ).toBe("读取〈Preface〉摘要");
  });

  it("getChapterSummary falls back when unresolved", () => {
    expect(
      toolStepLabel(part("tool-getChapterSummary", { input: { chapterId: "nope" } }), chapters, t),
    ).toBe("读取章节摘要");
  });

  it("getToc", () => {
    expect(toolStepLabel(part("tool-getToc"), chapters, t)).toBe("读取目录");
  });

  it("labels bash with the command folded onto one line", () => {
    const p = part("tool-bash", { input: { command: "cat <<EOF\n  hello\nEOF" } });
    expect(toolStepLabel(p, chapters, t)).toBe("运行命令：cat <<EOF hello EOF");
  });

  it("falls back to a generic bash label while the command is still streaming", () => {
    expect(toolStepLabel(part("tool-bash", { input: undefined }), chapters, t)).toBe("运行命令");
    expect(toolStepLabel(part("tool-bash", { input: { command: "  " } }), chapters, t)).toBe(
      "运行命令",
    );
  });

  it("labels memory tools in plain words, with the title when there is one", () => {
    const label = (name: string, input?: Record<string, unknown>) =>
      toolStepLabel(part(`tool-${name}`, { input }), chapters, t);
    expect(label("readMemory", { slug: "reading-style" })).toBe("读取记忆");
    expect(label("saveMemory", { title: "读法", description: "d", body: "b" })).toBe(
      "保存记忆「读法」",
    );
    expect(label("saveMemory", undefined)).toBe("保存记忆");
    expect(label("updateMemory", { slug: "reading-style", title: "读法" })).toBe(
      "更新记忆「读法」",
    );
    expect(label("updateMemory", { slug: "reading-style", body: "b" })).toBe("更新记忆");
    expect(label("deleteMemory", { slug: "reading-style" })).toBe("删除记忆");
    expect(label("updateSoul", { name: "x" })).toBe("更新人设");
  });

  it("unknown dynamic tool falls back to raw toolName", () => {
    const dyn = part("dynamic-tool", { toolName: "webSearch", input: {} });
    expect(toolStepLabel(dyn, chapters, t)).toBe("webSearch");
  });

  it("labels web_search with the query", () => {
    const p = part("tool-web_search", {
      input: { query: "weather" },
      state: "input-available",
    }) as any;
    expect(toolStepLabel(p, [], t)).toMatch(/weather/);
  });

  it("falls back when web_search query missing", () => {
    const p = part("tool-web_search", { input: {}, state: "input-streaming" }) as any;
    expect(toolStepLabel(p, [], t)).toBeTruthy();
  });

  it("labels web_fetch with the page host", () => {
    const p = part("tool-web_fetch", {
      input: { url: "https://en.wikipedia.org/wiki/Marginalia" },
      state: "input-available",
    }) as any;
    expect(toolStepLabel(p, [], t)).toMatch(/en\.wikipedia\.org/);
    expect(toolStepLabel(p, [], t)).not.toMatch(/wiki\/Marginalia/);
  });

  it("falls back when the web_fetch url is missing or partial", () => {
    const missing = part("tool-web_fetch", { input: {}, state: "input-streaming" }) as any;
    const partial = part("tool-web_fetch", {
      input: { url: "https:" },
      state: "input-streaming",
    }) as any;
    expect(toolStepLabel(missing, [], t)).toBeTruthy();
    expect(toolStepLabel(partial, [], t)).toBe(toolStepLabel(missing, [], t));
  });

  it("labels searchBook with the query", () => {
    const p = part("tool-searchBook", {
      input: { query: "unreliable narrator" },
      state: "input-available",
    }) as any;
    expect(toolStepLabel(p, [], t)).toBe("搜索书内：unreliable narrator");
  });

  it("falls back when searchBook query missing (streaming partial input)", () => {
    const p = part("tool-searchBook", { input: {}, state: "input-streaming" }) as any;
    expect(toolStepLabel(p, [], t)).toBe("搜索书内全文");
  });
});

describe("isErrorShape", () => {
  it("matches { error } object", () => {
    expect(isErrorShape({ error: "boom" })).toBe(true);
  });
  it("rejects others", () => {
    expect(isErrorShape({})).toBe(false);
    expect(isErrorShape(null)).toBe(false);
    expect(isErrorShape("error")).toBe(false);
    expect(isErrorShape(undefined)).toBe(false);
  });
});

describe("toolStepStatus", () => {
  it("output-error → failed", () => {
    expect(
      toolStepStatus(part("tool-readPage", { state: "output-error", errorText: "x" }), false),
    ).toBe("failed");
  });
  it("output-available with { error } result → failed (soft failure)", () => {
    expect(
      toolStepStatus(part("tool-readPage", { output: { error: "chapter not found" } }), false),
    ).toBe("failed");
  });
  it("output-available with normal result → done", () => {
    expect(toolStepStatus(part("tool-readPage", { output: { kind: "text" } }), false)).toBe("done");
  });
  it("input-streaming while the reply streams → loading", () => {
    expect(
      toolStepStatus(part("tool-readPage", { state: "input-streaming", output: undefined }), true),
    ).toBe("loading");
  });
  it("no output once the reply has ended → not-executed (dangling call, #109)", () => {
    expect(
      toolStepStatus(part("tool-readPage", { state: "input-available", output: undefined }), false),
    ).toBe("not-executed");
  });
});
