import { describe, expect, it } from "vitest";
import { answerTextOf, textOf } from "@renderer/ai/message-text";
import type { ChatUIMessage } from "@renderer/ai/types";

type Part = ChatUIMessage["parts"][number];

const text = (t: string): Part => ({ type: "text", text: t });
const toolPart: Part = {
  type: "tool-readPage",
  toolCallId: "c1",
  state: "output-available",
  input: { page: 1 },
  output: { kind: "text", page: 1, text: "x" },
} as Part;
const msg = (parts: Part[]): ChatUIMessage => ({ id: "m1", role: "assistant", parts });

describe("textOf", () => {
  it("concatenates multiple text parts (markdown source preserved)", () => {
    expect(textOf(msg([text("# Title"), text("\n\nbody")]))).toBe("# Title\n\nbody");
  });

  it("skips non-text parts such as tool steps", () => {
    expect(textOf(msg([text("before"), toolPart, text("after")]))).toBe("beforeafter");
  });

  it("returns empty string when there are no parts", () => {
    expect(textOf(msg([]))).toBe("");
  });
});

describe("answerTextOf", () => {
  const saveMemory: Part = {
    type: "tool-saveMemory",
    toolCallId: "m1",
    state: "output-available",
    input: { title: "t", description: "d", body: "b" },
    output: { ok: true },
  } as Part;

  it("is the whole text of a reply without tool calls", () => {
    expect(answerTextOf(msg([text("# Title"), text("\n\nbody")]))).toBe("# Title\n\nbody");
  });

  it("is only the text after the last tool call", () => {
    expect(answerTextOf(msg([text("let me look"), toolPart, text("the answer")]))).toBe(
      "the answer",
    );
  });

  it("keeps the answer written before a memory save", () => {
    expect(answerTextOf(msg([toolPart, text("the answer"), saveMemory, text("noted")]))).toBe(
      "the answer\n\nnoted",
    );
  });

  it("is empty when the reply ends with a tool call or has no text", () => {
    expect(answerTextOf(msg([text("a"), toolPart]))).toBe("");
    expect(answerTextOf(msg([]))).toBe("");
  });
});
