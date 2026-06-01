import { describe, expect, it } from "vitest";
import { qk } from "@renderer/query/keys";

describe("qk", () => {
  it("static keys", () => {
    expect(qk.library).toEqual(["library"]);
    expect(qk.providers).toEqual(["providers"]);
    expect(qk.assistantDefault).toEqual(["assistant", "default"]);
  });
  it("parametric keys", () => {
    expect(qk.toc("b1")).toEqual(["toc", "b1"]);
    expect(qk.chapter("b1", "c1")).toEqual(["chapter", "b1", "c1"]);
    expect(qk.conversations("b1")).toEqual(["conversations", "b1"]);
    expect(qk.messages("conv1")).toEqual(["messages", "conv1"]);
  });
});
