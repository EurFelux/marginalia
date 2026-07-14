import { describe, expect, it, vi } from "vitest";
import { C } from "@shared/ipc";
import { createApi } from "./preload-api";

/** 递归收集 api 对象树上所有带 __channel 标记的函数的通道名。 */
function collectChannels(node: unknown, acc: Set<string>): void {
  if (typeof node === "function") {
    const ch = (node as { __channel?: string }).__channel;
    if (ch) acc.add(ch);
    return;
  }
  if (node && typeof node === "object") {
    for (const v of Object.values(node)) collectChannels(v, acc);
  }
}

describe("app.onNotify", () => {
  it("subscribes to the app:notify channel and forwards payloads", () => {
    const handlers = new Map<string, (payload: unknown) => void>();
    const api = createApi({
      invoke: async () => undefined,
      on: (channel, cb) => {
        handlers.set(channel, cb);
        return () => handlers.delete(channel);
      },
      getPathForFile: () => "",
      prefsSnapshot: {},
      appLocale: "en",
    });
    const received: unknown[] = [];
    const unsub = api.app.onNotify((n) => received.push(n));
    handlers.get("app:notify")?.({ kind: "memoryConsolidated", saved: 1, updated: 0, deleted: 0 });
    expect(received).toEqual([{ kind: "memoryConsolidated", saved: 1, updated: 0, deleted: 0 }]);
    unsub();
    expect(handlers.has("app:notify")).toBe(false);
  });
});

describe("preload api coverage", () => {
  const api = createApi({
    invoke: vi.fn(() => Promise.resolve()),
    on: vi.fn(() => () => {}),
    getPathForFile: () => "",
    prefsSnapshot: {},
    appLocale: "en",
  });

  const bound = new Set<string>();
  collectChannels(api, bound);

  const invokeChannels = new Set(
    Object.values(C)
      .filter((c) => c.kind === "invoke")
      .map((c) => c.channel),
  );

  // 这一条是 main-only：有 handler、preload 故意不暴露（renderer 零引用）。
  const KNOWN_MAIN_ONLY = new Set(["conversations:get"]);

  it("every bound channel is a real invoke contract", () => {
    for (const ch of bound) expect(invokeChannels.has(ch), ch).toBe(true);
  });

  it("preload exposes all invoke channels except the known main-only set", () => {
    const notBound = new Set([...invokeChannels].filter((ch) => !bound.has(ch)));
    expect(notBound).toEqual(KNOWN_MAIN_ONLY);
  });
});

describe("readingSessions", () => {
  it("forwards lifecycle calls to their IPC contracts", async () => {
    const invoke = vi.fn(() => Promise.resolve());
    const api = createApi({
      invoke,
      on: vi.fn(() => () => {}),
      getPathForFile: () => "",
      prefsSnapshot: {},
      appLocale: "en",
    });

    await api.readingSessions.start({ mode: "continue", bookId: "b1" });
    await api.readingSessions.complete({ bookId: "b1" });
    await api.readingSessions.list({ bookId: "b1" });

    expect(invoke).toHaveBeenNthCalledWith(1, C.readingSessionsStart.channel, {
      mode: "continue",
      bookId: "b1",
    });
    expect(invoke).toHaveBeenNthCalledWith(2, C.readingSessionsComplete.channel, { bookId: "b1" });
    expect(invoke).toHaveBeenNthCalledWith(3, C.readingSessionsList.channel, { bookId: "b1" });
  });
});
