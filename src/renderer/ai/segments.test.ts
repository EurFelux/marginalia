import { describe, expect, it } from "vitest";
import { segments } from "@renderer/ai/segments";
import type { ChatUIMessage } from "@renderer/ai/types";

type Part = ChatUIMessage["parts"][number];

const text = (t: string): Part => ({ type: "text", text: t });
const toolPart = (over: Record<string, unknown> = {}): Part =>
  ({
    type: "tool-readPage",
    toolCallId: "c1",
    state: "output-available",
    input: { page: 1 },
    output: { kind: "text", page: 1, text: "x" },
    ...over,
  }) as Part;
const stepStart: Part = { type: "step-start" } as Part;

describe("segments", () => {
  it("preserves interleaved occurrence order", () => {
    const segs = segments([toolPart(), text("a"), toolPart({ toolCallId: "c2" }), text("b")]);
    expect(segs.map((s) => s.kind)).toEqual(["tool", "text", "tool", "text"]);
  });

  it("merges consecutive text parts into one segment", () => {
    const segs = segments([text("a"), text("b")]);
    expect(segs).toEqual([{ kind: "text", text: "ab" }]);
  });

  it("merges text parts separated only by filtered parts", () => {
    const segs = segments([text("a"), stepStart, text("b")]);
    expect(segs).toEqual([{ kind: "text", text: "ab" }]);
  });

  it("filters step-start and skips empty text parts", () => {
    expect(segments([stepStart, text("")])).toEqual([]);
  });

  it("returns empty for empty parts", () => {
    expect(segments([])).toEqual([]);
  });

  it("treats dynamic-tool parts as tool segments", () => {
    const dyn = {
      type: "dynamic-tool",
      toolName: "webSearch",
      toolCallId: "c9",
      state: "input-available",
      input: {},
    } as Part;
    const segs = segments([dyn]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe("tool");
  });
});
