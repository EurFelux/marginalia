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

  it("unknown dynamic tool falls back to raw toolName", () => {
    const dyn = part("dynamic-tool", { toolName: "webSearch", input: {} });
    expect(toolStepLabel(dyn, chapters, t)).toBe("webSearch");
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
    expect(toolStepStatus(part("tool-readPage", { state: "output-error", errorText: "x" }))).toBe(
      "failed",
    );
  });
  it("output-available with { error } result → failed (soft failure)", () => {
    expect(toolStepStatus(part("tool-readPage", { output: { error: "chapter not found" } }))).toBe(
      "failed",
    );
  });
  it("output-available with normal result → done", () => {
    expect(toolStepStatus(part("tool-readPage", { output: { kind: "text" } }))).toBe("done");
  });
  it("input-streaming → loading", () => {
    expect(
      toolStepStatus(part("tool-readPage", { state: "input-streaming", output: undefined })),
    ).toBe("loading");
  });
});
