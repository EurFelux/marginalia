import { describe, expect, it } from "vitest";
import { textOf } from "@renderer/ai/message-text";
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
