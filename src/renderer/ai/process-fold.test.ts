import { describe, expect, it } from "vitest";
import {
  answerText,
  assistantLayout,
  hasToolCall,
  runningStep,
  turnDurationParts,
} from "@renderer/ai/process-fold";
import type { Segment, ToolPart } from "@renderer/ai/segments";

const text = (t: string): Segment => ({ kind: "text", text: t });
const tool = (id: string, over: Record<string, unknown> = {}): Segment => ({
  kind: "tool",
  part: {
    type: "tool-readPage",
    toolCallId: id,
    state: "output-available",
    input: { page: 1 },
    output: { kind: "text", page: 1, text: "x" },
    ...over,
  } as ToolPart,
});
const memory = (id: string, name = "saveMemory"): Segment => ({
  kind: "tool",
  part: {
    type: `tool-${name}`,
    toolCallId: id,
    state: "output-available",
    input: { title: "t", description: "d", body: "b" },
    output: { ok: true },
  } as ToolPart,
});
const bash = (id: string): Segment => ({
  kind: "tool",
  part: {
    type: "tool-bash",
    toolCallId: id,
    state: "input-available",
    input: { command: "ls" },
  } as ToolPart,
});

const none = () => false;
const ids = (segs: Segment[]) =>
  segs.map((s) => (s.kind === "text" ? `text:${s.text}` : `tool:${s.part.toolCallId}`));

describe("assistantLayout", () => {
  it("shows a plain text reply as the answer with nothing folded", () => {
    expect(assistantLayout([text("hi")], none)).toEqual({
      process: [],
      awaiting: [],
      answer: [text("hi")],
    });
  });

  it("folds everything up to the last tool call, in order", () => {
    const layout = assistantLayout(
      [text("a"), tool("t1"), text("b"), tool("t2"), text("answer")],
      none,
    );
    expect(ids(layout.process)).toEqual(["text:a", "tool:t1", "text:b", "tool:t2"]);
    expect(ids(layout.answer)).toEqual(["text:answer"]);
  });

  it("folds everything and shows nothing when the reply ends with a tool call", () => {
    const layout = assistantLayout([text("a"), tool("t1")], none);
    expect(ids(layout.process)).toEqual(["text:a", "tool:t1"]);
    expect(layout.answer).toEqual([]);
  });

  it("folds a reply made only of tool calls", () => {
    const layout = assistantLayout([tool("t1"), tool("t2")], none);
    expect(ids(layout.process)).toEqual(["tool:t1", "tool:t2"]);
    expect(layout.answer).toEqual([]);
  });

  it("keeps the answer visible when memory is saved after it", () => {
    const layout = assistantLayout(
      [tool("t1"), text("the answer"), memory("m1"), text("noted")],
      none,
    );
    expect(ids(layout.process)).toEqual(["tool:t1"]);
    expect(ids(layout.answer)).toEqual(["text:the answer", "tool:m1", "text:noted"]);
  });

  it("does not fold a reply that only touched memory", () => {
    const layout = assistantLayout(
      [memory("m0", "readMemory"), text("answer"), memory("m1", "updateMemory"), text("ok")],
      none,
    );
    expect(layout.process).toEqual([]);
    expect(ids(layout.answer)).toEqual(["tool:m0", "text:answer", "tool:m1", "text:ok"]);
  });

  it("folds memory calls that come before other tool calls", () => {
    const layout = assistantLayout([memory("m0", "readMemory"), tool("t1"), text("answer")], none);
    expect(ids(layout.process)).toEqual(["tool:m0", "tool:t1"]);
    expect(ids(layout.answer)).toEqual(["text:answer"]);
  });

  it("keeps bash calls awaiting approval out of the fold, in order", () => {
    const awaiting = (p: ToolPart) => p.toolCallId.startsWith("b");
    const layout = assistantLayout([tool("t1"), bash("b1"), tool("t2"), bash("b2")], awaiting);
    expect(ids(layout.process)).toEqual(["tool:t1", "tool:t2"]);
    expect(layout.awaiting.map((p) => p.toolCallId)).toEqual(["b1", "b2"]);
  });

  it("leaves only text in the process when the sole tool call awaits approval", () => {
    const layout = assistantLayout([text("let me export"), bash("b1")], () => true);
    expect(ids(layout.process)).toEqual(["text:let me export"]);
    expect(hasToolCall(layout.process)).toBe(false);
  });
});

describe("answerText", () => {
  it("is the text of a single answer segment", () => {
    expect(answerText([text("hi")])).toBe("hi");
  });

  it("joins answer texts around memory steps with a blank line", () => {
    expect(answerText([text("the answer"), memory("m1"), text("noted")])).toBe(
      "the answer\n\nnoted",
    );
  });

  it("is empty when nothing stays visible", () => {
    expect(answerText([])).toBe("");
  });
});

describe("runningStep", () => {
  it("is the last tool call while it has no result and the reply is streaming", () => {
    const loading = tool("t2", { state: "input-available", output: undefined });
    expect(runningStep([tool("t1"), loading], true)?.toolCallId).toBe("t2");
  });

  it("is null once the last tool call has a result", () => {
    expect(runningStep([tool("t1")], true)).toBeNull();
  });

  it("is null after the reply ended, even for a tool call without a result", () => {
    const dangling = tool("t1", { state: "input-available", output: undefined });
    expect(runningStep([dangling], false)).toBeNull();
  });

  it("is null when the process ends with text", () => {
    expect(runningStep([tool("t1"), text("thinking")], true)).toBeNull();
  });
});

describe("turnDurationParts", () => {
  it("counts anything under a second as one second", () => {
    expect(turnDurationParts(0)).toEqual({ min: 0, sec: 1 });
    expect(turnDurationParts(400)).toEqual({ min: 0, sec: 1 });
  });

  it("rounds to the nearest second", () => {
    expect(turnDurationParts(12_499)).toEqual({ min: 0, sec: 12 });
    expect(turnDurationParts(12_500)).toEqual({ min: 0, sec: 13 });
  });

  it("splits out minutes from a minute on", () => {
    expect(turnDurationParts(59_499)).toEqual({ min: 0, sec: 59 });
    expect(turnDurationParts(59_500)).toEqual({ min: 1, sec: 0 });
    expect(turnDurationParts(72_800)).toEqual({ min: 1, sec: 13 });
  });
});
