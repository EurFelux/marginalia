import { describe, expect, it } from "vitest";
import type { UIMessageChunk } from "ai";
import type { AiStreamEvent } from "@shared/chat";
import { createEventStream } from "@renderer/ai/ipc-chat-transport";

/** 假订阅器：捕获回调，返回受控的 emit + 退订标志。 */
function fakeOnChunk() {
  let cb: ((ev: AiStreamEvent) => void) | null = null;
  let unsubbed = false;
  const onChunk = (_streamId: string, _cb: (ev: AiStreamEvent) => void) => {
    cb = _cb;
    return () => {
      unsubbed = true;
    };
  };
  return {
    onChunk,
    emit: (ev: AiStreamEvent) => cb?.(ev),
    get unsubbed() {
      return unsubbed;
    },
  };
}

const textChunk = (delta: string): AiStreamEvent => ({
  streamId: "s1",
  type: "chunk",
  chunk: { type: "text-delta", id: "t1", delta } as UIMessageChunk,
});

describe("createEventStream", () => {
  it("enqueues chunks, closes on finish, and unsubscribes", async () => {
    const fake = fakeOnChunk();
    const stream = createEventStream("s1", fake.onChunk);
    const reader = stream.getReader();
    fake.emit(textChunk("Hello"));
    fake.emit(textChunk(" world"));
    fake.emit({ streamId: "s1", type: "finish" });
    expect(((await reader.read()).value as { delta: string }).delta).toBe("Hello");
    expect(((await reader.read()).value as { delta: string }).delta).toBe(" world");
    expect((await reader.read()).done).toBe(true);
    expect(fake.unsubbed).toBe(true);
  });

  it("errors the stream and unsubscribes on an error event", async () => {
    const fake = fakeOnChunk();
    const stream = createEventStream("s1", fake.onChunk);
    const reader = stream.getReader();
    fake.emit({ streamId: "s1", type: "error", message: "boom" });
    await expect(reader.read()).rejects.toThrow("boom");
    expect(fake.unsubbed).toBe(true);
  });
});
