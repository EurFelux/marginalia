import { describe, expect, it } from "vitest";
import { contextKey, deriveChatContext } from "@renderer/ai/chat-context";

describe("chat-context", () => {
  it("contextKey namespaces book vs library", () => {
    expect(contextKey({ kind: "book", bookId: "b1" })).toBe("book:b1");
    expect(contextKey({ kind: "library" })).toBe("library");
  });
  it("deriveChatContext is book only in reader with a book, else library", () => {
    expect(deriveChatContext("reader", "b1")).toEqual({ kind: "book", bookId: "b1" });
    expect(deriveChatContext("reader", null)).toEqual({ kind: "library" });
    expect(deriveChatContext("library", "b1")).toEqual({ kind: "library" });
    expect(deriveChatContext("stats", null)).toEqual({ kind: "library" });
  });
});
