import { describe, expect, it, vi } from "vitest";
import { C } from "@shared/ipc";
import { pumpStream } from "@main/ipc/ai-handlers";
import type { SendResult } from "@main/ai/send";

type OkResult = Extract<SendResult, { ok: true }>;

function okResult(chunks: unknown[], finished = Promise.resolve()): OkResult {
  async function* gen() {
    for (const c of chunks) yield c as never;
  }
  return {
    ok: true,
    conversationId: "conv-1",
    stream: gen(),
    finished,
  };
}

function fakeSender() {
  return { isDestroyed: () => false, send: vi.fn() };
}

describe("pumpStream", () => {
  it("emits chunk* then finish", async () => {
    const sender = fakeSender();
    await pumpStream(
      sender,
      "s1",
      okResult([{ type: "x" }, { type: "y" }]),
      new AbortController().signal,
    );
    expect(sender.send.mock.calls).toEqual([
      [C.aiChunk.channel, { streamId: "s1", type: "chunk", chunk: { type: "x" } }],
      [C.aiChunk.channel, { streamId: "s1", type: "chunk", chunk: { type: "y" } }],
      [C.aiChunk.channel, { streamId: "s1", type: "finish" }],
    ]);
  });

  it("emits error when the stream throws (not aborted)", async () => {
    const sender = fakeSender();
    async function* boom() {
      yield { type: "x" } as never;
      throw new Error("boom");
    }
    const result = { ...okResult([]), stream: boom() } as OkResult;
    await pumpStream(sender, "s2", result, new AbortController().signal);
    const calls = sender.send.mock.calls;
    expect(calls.at(-1)).toEqual([
      C.aiChunk.channel,
      { streamId: "s2", type: "error", message: "boom" },
    ]);
  });

  it("emits finish (not error) when aborted mid-stream", async () => {
    const sender = fakeSender();
    const controller = new AbortController();
    async function* boom() {
      yield { type: "x" } as never;
      controller.abort();
      throw new Error("aborted by signal");
    }
    const result = { ...okResult([]), stream: boom() } as OkResult;
    await pumpStream(sender, "s3", result, controller.signal);
    expect(sender.send.mock.calls.at(-1)).toEqual([
      C.aiChunk.channel,
      { streamId: "s3", type: "finish" },
    ]);
  });

  it("does not send to a destroyed sender", async () => {
    const sender = { isDestroyed: () => true, send: vi.fn() };
    await pumpStream(sender, "s4", okResult([{ type: "x" }]), new AbortController().signal);
    expect(sender.send).not.toHaveBeenCalled();
  });
});
