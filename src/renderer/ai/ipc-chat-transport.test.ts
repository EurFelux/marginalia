import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { UIMessageChunk } from "ai";
import type { AiStreamEvent } from "@shared/chat";
import { createEventStream, createIpcChatTransport } from "@renderer/ai/ipc-chat-transport";
import { useNavigationStore, NAVIGATION_INITIAL } from "@renderer/store/navigation-store";
import { useChatStore, CHAT_INITIAL } from "@renderer/store/chat-store";
import type { ChatUIMessage } from "@renderer/ai/types";

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

// ────────────────────────────────────────────────────────────────────────────
// createIpcChatTransport — sendMessages 集成测试（使用假 window.api）
// ────────────────────────────────────────────────────────────────────────────

/** 构建最小假 window.api */
function makeApi(overrides?: {
  sendResult?: { ok: true; conversationId: string } | { ok: false; reason: string };
  createResult?: { id: string };
}) {
  const sentPayloads: unknown[] = [];
  const createdPayloads: unknown[] = [];

  // onChunk 订阅器：即刻推送 finish（让 await send 解除阻塞）
  let onChunkCb: ((ev: AiStreamEvent) => void) | undefined;
  const onChunk = (_streamId: string, cb: (ev: AiStreamEvent) => void) => {
    onChunkCb = cb;
    return () => {};
  };

  const api = {
    ai: {
      send: vi.fn(async (payload: unknown) => {
        sentPayloads.push(payload);
        // 在 send 返回后触发 finish（使 stream 关闭）
        setTimeout(
          () =>
            onChunkCb?.({ streamId: (payload as { streamId: string }).streamId, type: "finish" }),
          0,
        );
        return overrides?.sendResult ?? { ok: true, conversationId: "conv-from-send" };
      }),
      abort: vi.fn(),
      onChunk,
    },
    chat: {
      conversations: {
        create: vi.fn(async (payload: unknown) => {
          createdPayloads.push(payload);
          return (
            overrides?.createResult ?? {
              id: "new-conv-id",
              bookId: "book-1",
              chapterId: null,
              kind: "independent",
              assistantId: "a1",
              title: null,
              createdAt: 0,
              updatedAt: 0,
            }
          );
        }),
      },
    },
  };

  return { api, sentPayloads, createdPayloads };
}

function makeMessage(text: string): ChatUIMessage {
  return {
    role: "user",
    id: "msg-1",
    parts: [{ type: "text", text }],
    metadata: undefined,
  } as ChatUIMessage;
}

describe("createIpcChatTransport sendMessages", () => {
  beforeEach(() => {
    useNavigationStore.setState({ ...NAVIGATION_INITIAL, currentBookId: "book-1" });
    useChatStore.setState({ ...CHAT_INITIAL, activeConversationId: "existing-conv" });
  });

  afterEach(() => {
    useNavigationStore.setState(NAVIGATION_INITIAL);
    useChatStore.setState(CHAT_INITIAL);
    vi.unstubAllGlobals();
  });

  it("sends payload with conversationId and bookId (no currentChapterId/activeConversationId)", async () => {
    const { api, sentPayloads } = makeApi();
    vi.stubGlobal("window", { api });

    const transport = createIpcChatTransport();
    const stream = await transport.sendMessages({
      messages: [makeMessage("hello")],
      abortSignal: undefined,
      trigger: "submit-message" as const,
      chatId: "chat-1",
      messageId: undefined,
    });
    // drain stream
    const reader = stream.getReader();
    await reader.read(); // done=true from finish

    expect(sentPayloads).toHaveLength(1);
    const payload = sentPayloads[0] as Record<string, unknown>;
    expect(payload).toHaveProperty("bookId", "book-1");
    expect(payload).toHaveProperty("conversationId", "existing-conv");
    expect(payload).not.toHaveProperty("currentChapterId");
    expect(payload).not.toHaveProperty("activeConversationId");
  });

  it("lazily creates a conversation when activeConversationId is null, then sends", async () => {
    useChatStore.setState({ ...CHAT_INITIAL, activeConversationId: null });
    const { api, sentPayloads, createdPayloads } = makeApi({ createResult: { id: "lazy-conv" } });
    vi.stubGlobal("window", { api });

    const transport = createIpcChatTransport();
    const stream = await transport.sendMessages({
      messages: [makeMessage("hello")],
      abortSignal: undefined,
      trigger: "submit-message" as const,
      chatId: "chat-1",
      messageId: undefined,
    });
    const reader = stream.getReader();
    await reader.read();

    expect(createdPayloads).toHaveLength(1);
    expect(sentPayloads).toHaveLength(1);
    const payload = sentPayloads[0] as Record<string, unknown>;
    expect(payload).toHaveProperty("conversationId", "lazy-conv");
    // store should be updated
    expect(useChatStore.getState().activeConversationId).toBe("lazy-conv");
  });

  it("throws when bookId is missing", async () => {
    useNavigationStore.setState({ ...NAVIGATION_INITIAL, currentBookId: null });
    const { api } = makeApi();
    vi.stubGlobal("window", { api });

    const transport = createIpcChatTransport();
    await expect(
      transport.sendMessages({
        messages: [makeMessage("hello")],
        abortSignal: undefined,
        trigger: "submit-message",
        chatId: "chat-1",
        messageId: undefined,
      }),
    ).rejects.toThrow();
  });

  it("rejects with ack reason and unsubscribes onChunk when ack returns ok:false", async () => {
    // 构造一个带退订记录的 onChunk（不依赖 makeApi 内的 setTimeout finish——ok:false 走 cancel 路径，不需 finish）
    let unsubCalled = false;
    const onChunk = (_streamId: string, _cb: (ev: AiStreamEvent) => void) => {
      return () => {
        unsubCalled = true;
      };
    };

    const api = {
      ai: {
        send: vi.fn(async () => ({ ok: false as const, reason: "model not configured" })),
        abort: vi.fn(),
        onChunk,
      },
      chat: {
        conversations: {
          create: vi.fn(async () => ({
            id: "new-conv-id",
            bookId: "book-1",
            chapterId: null,
            kind: "independent",
            assistantId: "a1",
            title: null,
            createdAt: 0,
            updatedAt: 0,
          })),
        },
      },
    };
    vi.stubGlobal("window", { api });

    const transport = createIpcChatTransport();
    await expect(
      transport.sendMessages({
        messages: [makeMessage("hello")],
        abortSignal: undefined,
        trigger: "submit-message" as const,
        chatId: "chat-1",
        messageId: undefined,
      }),
    ).rejects.toThrow("model not configured");

    // stream.cancel() 触发 ReadableStream cancel → 调用 unsub
    expect(unsubCalled).toBe(true);
  });
});
