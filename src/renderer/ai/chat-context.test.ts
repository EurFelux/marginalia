import { describe, expect, it } from "vitest";
import { contextKey, deriveChatContext, resolveOpenCommandTarget } from "@renderer/ai/chat-context";

describe("chat-context", () => {
  it("contextKey namespaces book vs library", () => {
    expect(contextKey({ kind: "book", bookId: "b1" })).toBe("book:b1");
    expect(contextKey({ kind: "library" })).toBe("library");
  });
  it("deriveChatContext is book only in book view with a book, else library", () => {
    expect(deriveChatContext("book", "b1")).toEqual({ kind: "book", bookId: "b1" });
    expect(deriveChatContext("book", null)).toEqual({ kind: "library" });
    expect(deriveChatContext("library", "b1")).toEqual({ kind: "library" });
    expect(deriveChatContext("stats", null)).toEqual({ kind: "library" });
  });
});

describe("resolveOpenCommandTarget", () => {
  const libraryCtx = { kind: "library" } as const;
  const bookCtx = { kind: "book", bookId: "b1" } as const;

  it("returns null when there is no open command", () => {
    expect(resolveOpenCommandTarget(null, contextKey(libraryCtx))).toBeNull();
  });
  it("returns the conversation id when the command targets the panel", () => {
    expect(
      resolveOpenCommandTarget(
        { conversationId: "c1", context: libraryCtx, nonce: 1 },
        contextKey(libraryCtx),
      ),
    ).toBe("c1");
    expect(
      resolveOpenCommandTarget(
        { conversationId: "c2", context: bookCtx, nonce: 1 },
        contextKey(bookCtx),
      ),
    ).toBe("c2");
  });
  it("returns null when a book command leaks into the library panel (the reported bug)", () => {
    expect(
      resolveOpenCommandTarget(
        { conversationId: "c1", context: bookCtx, nonce: 1 },
        contextKey(libraryCtx),
      ),
    ).toBeNull();
  });
  it("returns null across different books (defense in depth)", () => {
    expect(
      resolveOpenCommandTarget(
        { conversationId: "c1", context: bookCtx, nonce: 1 },
        contextKey({ kind: "book", bookId: "b2" }),
      ),
    ).toBeNull();
  });
});
