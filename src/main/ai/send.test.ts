// src/main/ai/send.test.ts
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { MockLanguageModelV4, simulateReadableStream } from "ai/test";
import { makeFixtureEpub } from "@marginalia/epub-parser";
import { makeTextPdf } from "@marginalia/pdf-parser/fixture";
import { createDb, runMigrations } from "@main/db/client";
import { importBook } from "@main/library/repository";
import {
  createConversation,
  deleteConversation,
  getConversation,
  listConversationsByBook,
  setConversationTitle,
} from "@main/chat/conversations";
import { appendMessage, getMessage, listMessages } from "@main/chat/messages";
import { buildChips } from "@main/ai/chips";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { LoadBytes } from "@main/ai/tools";
import { runResend, runSend, type SendDeps, type SendInput } from "@main/ai/send";
import { __resetNamingRuntime } from "@main/chat/conversation-title";
import type { RunBackground } from "@main/ai/background-limiter";

const passThrough: RunBackground = (fn) => fn();

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

// V3 流分片形状（与 summary.test.ts 的 genModel 同源）。usage 嵌套、finishReason 为对象。
const USAGE = {
  inputTokens: { total: 1, noCache: undefined, cacheRead: undefined, cacheWrite: undefined },
  outputTokens: { total: 1, text: undefined, reasoning: undefined },
};
const finishChunk = (reason: "stop" | "tool-calls") => ({
  type: "finish" as const,
  finishReason: { unified: reason, raw: undefined },
  usage: USAGE,
});

function textStreamModel(text: string) {
  return new MockLanguageModelV4({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "text-start", id: "t1" },
          { type: "text-delta", id: "t1", delta: text },
          { type: "text-end", id: "t1" },
          finishChunk("stop"),
        ],
      }),
    }),
  });
}

/** 仅 doGenerate 的 mock（auto-naming 专用——naming 现走独立 resolveSummaryModel）。 */
function namingOnlyModel(namingTitle: string) {
  return new MockLanguageModelV4({
    doGenerate: async () => ({
      finishReason: { unified: "stop" as const, raw: undefined },
      usage: USAGE,
      content: [{ type: "text" as const, text: namingTitle }],
      warnings: [],
    }),
  });
}

// 两步 agent mock：第1步发 getToc 工具调用，第2步发文本。
function tocThenTextModel(text: string) {
  let call = 0;
  return new MockLanguageModelV4({
    doStream: async () => {
      call += 1;
      if (call === 1) {
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "tool-call" as const, toolCallId: "c1", toolName: "getToc", input: "{}" },
              finishChunk("tool-calls"),
            ],
          }),
        };
      }
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: text },
            { type: "text-end", id: "t1" },
            finishChunk("stop"),
          ],
        }),
      };
    },
  });
}

async function setup(
  model: ResolvedModel,
  summaryModel: ResolvedModel = { ok: false, reason: "summary model unset" },
) {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  const bytes = makeFixtureEpub();
  const book = await importBook(db, { bytes });
  const loadBytes: LoadBytes = async () => bytes;
  const deps: SendDeps = {
    db,
    loadBytes,
    resolveModel: () => model,
    resolveSummaryModel: () => summaryModel,
    runBackground: passThrough,
    notify: () => {},
  };
  return { db, book, deps };
}

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

async function seedBook(db: ReturnType<typeof freshDb>) {
  const bytes = makeFixtureEpub();
  return importBook(db, { bytes });
}

function makeDeps(db: ReturnType<typeof freshDb>): SendDeps {
  const bytes = makeFixtureEpub();
  const loadBytes: LoadBytes = async () => bytes;
  const model: ResolvedModel = { ok: true, model: textStreamModel("ok"), modelId: "mock" };
  return {
    db,
    loadBytes,
    resolveModel: () => model,
    resolveSummaryModel: () => ({ ok: false as const, reason: "summary model unset" }),
    runBackground: passThrough,
    notify: () => {},
  };
}

function input(bookId: string, conversationId: string, over: Partial<SendInput> = {}): SendInput {
  return {
    bookId,
    conversationId,
    chips: buildChips({ selection: "the cat", paragraphCurrent: "the cat sat on the mat" }),
    userText: "what does this mean?",
    ...over,
  };
}

describe("runSend conversation validation", () => {
  it("rejects unknown conversationId without writing anything", async () => {
    const db = freshDb();
    await seedBook(db);
    const result = await runSend(makeDeps(db), {
      bookId: "book-1",
      conversationId: "nope",
      chips: [],
      userText: "hi",
    });
    // 校验：runSend 拒绝未知会话，返回错误（i18n 在测试环境未初始化，不断言 reason 文案）
    expect(result.ok).toBe(false);
  });

  it("rejects a conversation belonging to another book", async () => {
    const db = freshDb();
    const book1 = await seedBook(db);
    const book2 = await importBook(db, {
      bytes: makeFixtureEpub({ identifier: "urn:uuid:other-book" }),
    });
    const other = createConversation(db, { bookId: book2.id });
    const result = await runSend(makeDeps(db), {
      bookId: book1.id,
      conversationId: other.id,
      chips: [],
      userText: "hi",
    });
    expect(result.ok).toBe(false);
  });
});

describe("runSend", () => {
  beforeEach(() => __resetNamingRuntime());

  it("returns an error and creates nothing when no model is configured", async () => {
    const { db, book, deps } = await setup({ ok: false, reason: "not configured" });
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, input(book.id, convo.id));
    expect(r.ok).toBe(false);
    expect(listConversationsByBook(db, book.id)).toHaveLength(1); // conversation still there, just no messages
  });

  it("persists the user message with a chip snapshot and the streamed assistant message", async () => {
    const { db, book, deps } = await setup({
      ok: true,
      model: textStreamModel("It means hello."),
      modelId: "mock",
    });
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, input(book.id, convo.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;

    const msgs = listMessages(db, r.conversationId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]);
    const user = msgs[0];
    expect(user.parts).toEqual([{ type: "text", text: "what does this mean?" }]);
    expect(user.metadata?.contextChips?.map((c) => c.id)).toEqual(["selection", "paragraph"]);
    expect(user.metadata?.model).toBe("mock");
    const assistantText = msgs[1].parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(assistantText).toContain("It means hello.");
    expect(msgs[1].status).toBe("complete");
    expect(msgs[1].metadata?.usage).toEqual({ inputTokens: 1, outputTokens: 1 });
  });

  it("runs the tool-calling agent loop and persists tool parts in the assistant message", async () => {
    const { db, book, deps } = await setup({
      ok: true,
      model: tocThenTextModel("Done."),
      modelId: "mock",
    });
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, input(book.id, convo.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;

    const assistant = listMessages(db, r.conversationId).find((m) => m.role === "assistant")!;
    const partTypes = assistant.parts.map((p) => p.type);
    expect(partTypes.some((t) => t.startsWith("tool-") || t === "dynamic-tool")).toBe(true);
    expect(partTypes).toContain("text");
    expect(JSON.stringify(assistant.parts)).toContain("Chapter One");
  });

  it("persists an error-status assistant message when streaming errors", async () => {
    const failModel = new MockLanguageModelV4({
      doStream: async () => {
        throw new Error("stream boom");
      },
    });
    const { db, book, deps } = await setup({ ok: true, model: failModel, modelId: "mock" });
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, input(book.id, convo.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;
    const msgs = listMessages(db, r.conversationId);
    expect(msgs.map((m) => m.role)).toEqual(["user", "assistant"]); // 不再是孤儿 user turn
    const assistant = msgs[1];
    expect(assistant.status).toBe("error");
    expect(assistant.metadata?.error?.message).toContain("stream boom");
  });

  it("forwards a non-aborted signal without breaking the normal persist path", async () => {
    const controller = new AbortController();
    const { db, book, deps } = await setup({
      ok: true,
      model: textStreamModel("hello"),
      modelId: "mock",
    });
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, input(book.id, convo.id), { abortSignal: controller.signal });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;
    // 正常路径：user + assistant 两条都落库
    expect(listMessages(db, r.conversationId)).toHaveLength(2);
  });

  it("persists an aborted-status assistant message when the signal aborts mid-stream", async () => {
    const controller = new AbortController();
    // 延迟分片：abort 在分片尚未发完时触发 → onFinish 收 isAborted=true。
    const slowModel = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunkDelayInMs: 50,
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "partial" },
            { type: "text-end", id: "t1" },
            finishChunk("stop"),
          ],
        }),
      }),
    });
    const { db, book, deps } = await setup({ ok: true, model: slowModel, modelId: "mock" });
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, input(book.id, convo.id), { abortSignal: controller.signal });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    controller.abort(); // runSend 返回后立即中止，分片仍在 50ms 延迟途中
    await r.finished;
    const assistant = listMessages(db, r.conversationId).find((m) => m.role === "assistant");
    expect(assistant?.status).toBe("aborted");
  });

  it("drops the assistant persist when the conversation is deleted mid-stream", async () => {
    const controller = new AbortController();
    // 延迟分片：abort+delete 发生在分片尚未发完时（镜像 conversations:delete 的服务端顺序）。
    const slowModel = new MockLanguageModelV4({
      doStream: async () => ({
        stream: simulateReadableStream({
          chunkDelayInMs: 50,
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "partial" },
            { type: "text-end", id: "t1" },
            finishChunk("stop"),
          ],
        }),
      }),
    });
    const { db, book, deps } = await setup({ ok: true, model: slowModel, modelId: "mock" });
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, input(book.id, convo.id), { abortSignal: controller.signal });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    // 镜像 conversations:delete binding 的顺序：先 abort 在跑流，再删行
    controller.abort();
    deleteConversation(db, convo.id);
    await r.finished; // 顺利收尾，不抛
    expect(getConversation(db, convo.id)).toBeNull();
    expect(listMessages(db, convo.id)).toEqual([]); // 无孤儿消息（user 已级联删，assistant 不落）
  });

  it("omits the paragraph chip from the snapshot when it duplicates the conversation's last", async () => {
    const { db, book, deps } = await setup({
      ok: true,
      model: textStreamModel("ok"),
      modelId: "mock",
    });
    const convo = createConversation(db, { bookId: book.id });
    const first = await runSend(
      deps,
      input(book.id, convo.id, {
        chips: buildChips({ selection: "s1", paragraphCurrent: "dup para" }),
        userText: "q1",
      }),
    );
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    await first.finished;

    const second = await runSend(
      deps,
      input(book.id, convo.id, {
        chips: buildChips({ selection: "s2", paragraphCurrent: "dup para" }),
        userText: "q2",
      }),
    );
    expect(second.ok).toBe(true);
    if (!second.ok) return;
    await second.finished;

    const userMsgs = listMessages(db, convo.id).filter((m) => m.role === "user");
    const lastUser = userMsgs[userMsgs.length - 1];
    expect(lastUser.metadata?.contextChips?.map((c) => c.id)).toEqual(["selection"]);
  });

  it("auto-names the conversation after the first completed turn", async () => {
    const { db, book, deps } = await setup(
      { ok: true, model: textStreamModel("It means hello."), modelId: "mock" },
      { ok: true, model: namingOnlyModel("AI 标题"), modelId: "summary-model" },
    );
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, input(book.id, convo.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;
    await vi.waitFor(() => expect(getConversation(db, convo.id)?.title).toBe("AI 标题"));
  });

  it("does not rename a conversation that already has a title", async () => {
    const { db, book, deps } = await setup(
      { ok: true, model: textStreamModel("answer"), modelId: "mock" },
      { ok: true, model: namingOnlyModel("AI 名"), modelId: "summary-model" },
    );
    const convo = createConversation(db, { bookId: book.id });
    setConversationTitle(db, convo.id, "既有名");
    const r = await runSend(deps, input(book.id, convo.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;
    await vi.waitFor(() => expect(getConversation(db, convo.id)?.title).toBe("既有名"));
  });

  it("skips naming when the summary model is unconfigured; chat still completes", async () => {
    const { db, book, deps } = await setup(
      { ok: true, model: textStreamModel("It means hello."), modelId: "mock" },
      { ok: false, reason: "unset" },
    );
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, input(book.id, convo.id));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;
    // 等 assistant 落库即可——naming 已因 ok:false 同步跳过，无异步尾部
    await vi.waitFor(() => {
      const msgs = listMessages(db, r.conversationId);
      const assistant = msgs.find((m) => m.role === "assistant");
      expect(assistant?.status).toBe("complete");
    });
    // Title stays null — naming was skipped because summary model is unset
    expect(getConversation(db, convo.id)?.title).toBeNull();
  });
});

function providerOptionsCapturingModel(captured: { providerOptions?: unknown }) {
  return new MockLanguageModelV4({
    doStream: async ({ providerOptions }) => {
      captured.providerOptions = providerOptions;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "ok" },
            { type: "text-end", id: "t1" },
            finishChunk("stop"),
          ],
        }),
      };
    },
  });
}

describe("openai-responses store handling", () => {
  it("forces store:false for openai-responses providers (无状态网关：reasoning item 不可被 id 引用回传)", async () => {
    const captured: { providerOptions?: unknown } = {};
    const { db, book, deps } = await setup({
      ok: true,
      model: providerOptionsCapturingModel(captured),
      modelId: "gpt-5",
      providerType: "openai-responses",
    });
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, input(book.id, convo.id));
    if (!r.ok) throw new Error(r.reason);
    await r.finished;
    expect(captured.providerOptions).toEqual({ openai: { store: false } });
  });

  it("does not impose openai store on non-responses providers (anthropic)", async () => {
    const captured: { providerOptions?: unknown } = {};
    const { db, book, deps } = await setup({
      ok: true,
      model: providerOptionsCapturingModel(captured),
      modelId: "claude",
      providerType: "anthropic",
    });
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, input(book.id, convo.id));
    if (!r.ok) throw new Error(r.reason);
    await r.finished;
    expect(
      (captured.providerOptions as { openai?: { store?: unknown } } | undefined)?.openai?.store,
    ).toBeUndefined();
  });
});

function reasoningCapturingModel(captured: { reasoning?: unknown }) {
  return new MockLanguageModelV4({
    doStream: async ({ reasoning }) => {
      captured.reasoning = reasoning;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "ok" },
            { type: "text-end", id: "t1" },
            finishChunk("stop"),
          ],
        }),
      };
    },
  });
}

describe("reasoning effort forwarding", () => {
  it("forwards chat model's reasoningEffort as top-level reasoning", async () => {
    const captured: { reasoning?: unknown } = {};
    const { db, book, deps } = await setup({
      ok: true,
      model: reasoningCapturingModel(captured),
      modelId: "claude",
      providerType: "anthropic",
      reasoningEffort: "high",
    });
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, input(book.id, convo.id));
    if (!r.ok) throw new Error(r.reason);
    await r.finished;
    expect(captured.reasoning).toBe("high");
  });

  it("passes undefined reasoning when effort unset (= provider default)", async () => {
    const captured: { reasoning?: unknown } = {};
    const { db, book, deps } = await setup({
      ok: true,
      model: reasoningCapturingModel(captured),
      modelId: "claude",
      providerType: "anthropic",
    });
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, input(book.id, convo.id));
    if (!r.ok) throw new Error(r.reason);
    await r.finished;
    expect(captured.reasoning).toBeUndefined();
  });
});

type CapturedMsg = { role: string; providerOptions?: { anthropic?: { cacheControl?: unknown } } };

function rawPromptCapturingModel(captured: { prompt?: CapturedMsg[] }) {
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      captured.prompt = prompt as unknown as CapturedMsg[];
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "ok" },
            { type: "text-end", id: "t1" },
            finishChunk("stop"),
          ],
        }),
      };
    },
  });
}

describe("anthropic prompt caching", () => {
  const cc = (m: CapturedMsg | undefined) => m?.providerOptions?.anthropic?.cacheControl;

  it("marks system and the current user turn with an ephemeral cache breakpoint", async () => {
    const captured: { prompt?: CapturedMsg[] } = {};
    const { db, book, deps } = await setup({
      ok: true,
      model: rawPromptCapturingModel(captured),
      modelId: "claude",
      providerType: "anthropic",
    });
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, input(book.id, convo.id));
    if (!r.ok) throw new Error(r.reason);
    await r.finished;
    const prompt = captured.prompt ?? [];
    expect(cc(prompt.find((m) => m.role === "system"))).toEqual({ type: "ephemeral" });
    expect(cc([...prompt].reverse().find((m) => m.role === "user"))).toEqual({ type: "ephemeral" });
  });

  it("does not add cache breakpoints for non-anthropic providers", async () => {
    const captured: { prompt?: CapturedMsg[] } = {};
    const { db, book, deps } = await setup({
      ok: true,
      model: rawPromptCapturingModel(captured),
      modelId: "gpt-5",
      providerType: "openai-responses",
    });
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, input(book.id, convo.id));
    if (!r.ok) throw new Error(r.reason);
    await r.finished;
    for (const m of captured.prompt ?? []) expect(cc(m)).toBeUndefined();
  });
});

describe("current date/time injection", () => {
  it("injects the current date/time into the live user turn, not the system prompt", async () => {
    const captured: { prompt?: CapturedMsg[] } = {};
    const { db, book, deps } = await setup({
      ok: true,
      model: rawPromptCapturingModel(captured),
      modelId: "mock",
    });
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, input(book.id, convo.id));
    if (!r.ok) throw new Error(r.reason);
    await r.finished;
    const prompt = captured.prompt ?? [];
    const lastUser = [...prompt].reverse().find((m) => m.role === "user");
    expect(JSON.stringify(lastUser)).toContain("Current date and time");
    const system = prompt.find((m) => m.role === "system");
    expect(JSON.stringify(system)).not.toContain("Current date and time");
  });
});

function systemCapturingModel(captured: { system?: string }) {
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const sys = prompt.find((m) => m.role === "system");
      captured.system = sys && typeof sys.content === "string" ? sys.content : undefined;
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "ok" },
            { type: "text-end", id: "t1" },
            finishChunk("stop"),
          ],
        }),
      };
    },
  });
}

describe("pdf system prompt injection", () => {
  it("appends a pdf note (with image hint for capable providers) for pdf books", async () => {
    const captured: { system?: string } = {};
    const db = createDb(":memory:");
    runMigrations(db, MIGRATIONS);
    const bytes = await makeTextPdf({ outline: true, title: "P" });
    const book = await importBook(db, { bytes });
    const deps: SendDeps = {
      db,
      loadBytes: async () => bytes,
      resolveModel: () => ({
        ok: true,
        model: systemCapturingModel(captured),
        modelId: "m",
        providerType: "anthropic",
      }),
      resolveSummaryModel: () => ({ ok: false, reason: "unset" }),
      runBackground: passThrough,
      notify: () => {},
    };
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, {
      bookId: book.id,
      conversationId: convo.id,
      userText: "hi",
      chips: [],
    });
    if (!r.ok) throw new Error(r.reason);
    await r.finished;
    expect(captured.system).toContain("is a PDF");
    expect(captured.system).toContain("3 pages");
    expect(captured.system).toContain('mode "image"');
  });

  it("does not mention PDF for epub books", async () => {
    const captured: { system?: string } = {};
    const { db, book, deps } = await setup({
      ok: true,
      model: systemCapturingModel(captured),
      modelId: "m",
    });
    const convo = createConversation(db, { bookId: book.id });
    const r = await runSend(deps, {
      bookId: book.id,
      conversationId: convo.id,
      userText: "hi",
      chips: [],
    });
    if (!r.ok) throw new Error(r.reason);
    await r.finished;
    expect(captured.system).not.toContain("is a PDF");
  });
});

function promptCapturingModel(captured: { system?: string; texts: string[] }) {
  return new MockLanguageModelV4({
    doStream: async ({ prompt }) => {
      const sys = prompt.find((m) => m.role === "system");
      captured.system = sys && typeof sys.content === "string" ? sys.content : undefined;
      captured.texts = prompt
        .filter((m) => m.role === "user" || m.role === "assistant")
        .map((m) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));
      return {
        stream: simulateReadableStream({
          chunks: [
            { type: "text-start", id: "t1" },
            { type: "text-delta", id: "t1", delta: "ok" },
            { type: "text-end", id: "t1" },
            finishChunk("stop"),
          ],
        }),
      };
    },
  });
}

describe("runSend context summary injection", () => {
  it("injects the stored summary into system and sends only the tail history", async () => {
    const captured: { system?: string; texts: string[] } = { texts: [] };
    const { db, book, deps } = await setup({
      ok: true,
      model: promptCapturingModel(captured),
      modelId: "mock",
    });
    const { createConversation } = await import("@main/chat/conversations");
    const { appendMessage } = await import("@main/chat/messages");
    const { conversations } = await import("@main/db/schema");
    const { eq } = await import("drizzle-orm");

    const convo = createConversation(db, { bookId: book.id });
    appendMessage(db, {
      conversationId: convo.id,
      role: "user",
      parts: [{ type: "text", text: "FOLDED_USER" }],
    });
    appendMessage(db, {
      conversationId: convo.id,
      role: "assistant",
      parts: [{ type: "text", text: "KEPT_ASSISTANT" }],
    });
    db.update(conversations)
      .set({ contextSummary: "EARLIER_SUMMARY", summarizedThroughSeq: 0 })
      .where(eq(conversations.id, convo.id))
      .run();

    const r = await runSend(deps, input(book.id, convo.id, { chips: [], userText: "now" }));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;

    expect(captured.system).toContain("## Conversation summary so far\nEARLIER_SUMMARY");
    const joined = captured.texts.join("\n");
    expect(joined).toContain("KEPT_ASSISTANT");
    expect(joined).not.toContain("FOLDED_USER");
    expect(joined).toContain("now");
  });
});

describe("runSend library context", () => {
  beforeEach(() => __resetNamingRuntime());

  it("runSend with null bookId uses the librarian prompt and library tools", async () => {
    const db = freshDb();
    const convo = createConversation(db, { bookId: null });

    let capturedSystem = "";
    const capturingModel = new MockLanguageModelV4({
      doStream: async ({ prompt }) => {
        const sys = prompt.find((m) => m.role === "system");
        capturedSystem = sys && typeof sys.content === "string" ? sys.content : "";
        return {
          stream: simulateReadableStream({
            chunks: [
              { type: "text-start", id: "t1" },
              { type: "text-delta", id: "t1", delta: "Try Meditations." },
              { type: "text-end", id: "t1" },
              finishChunk("stop"),
            ],
          }),
        };
      },
    });

    const loadBytes: LoadBytes = async () => makeFixtureEpub();
    const deps: SendDeps = {
      ...makeDeps(db),
      loadBytes,
      resolveModel: () => ({ ok: true, model: capturingModel, modelId: "mock" }),
    };

    const res = await runSend(deps, {
      bookId: null,
      conversationId: convo.id,
      chips: [],
      userText: "what should I read next?",
    });
    expect(res.ok).toBe(true);
    if (res.ok) await res.finished;
    expect(capturedSystem.startsWith("You are a personal librarian")).toBe(true);
    const msgs = listMessages(db, convo.id);
    expect(msgs.some((m) => m.role === "assistant")).toBe(true);
  });
});

describe("runResend", () => {
  beforeEach(() => __resetNamingRuntime());

  async function seedTurn(deps: SendDeps, db: ReturnType<typeof createDb>, bookId: string) {
    const convo = createConversation(db, { bookId });
    const r = await runSend(deps, input(bookId, convo.id, { userText: "first question" }));
    if (!r.ok) throw new Error(r.reason);
    await r.finished;
    return convo;
  }

  it("rejects when the model is unconfigured without mutating", async () => {
    const { db, book, deps } = await setup({ ok: false, reason: "no model" });
    const convo = createConversation(db, { bookId: book.id });
    const u = appendMessage(db, {
      conversationId: convo.id,
      role: "user",
      parts: [{ type: "text", text: "q" }],
    });
    const r = await runResend(deps, {
      conversationId: convo.id,
      userMessageId: u.id,
      userText: "q",
    });
    expect(r.ok).toBe(false);
    expect(listMessages(db, convo.id)).toHaveLength(1); // unchanged
  });

  it("rejects an unknown / non-user / cross-conversation message", async () => {
    const { db, book, deps } = await setup({
      ok: true,
      model: textStreamModel("x"),
      modelId: "mock",
    });
    const convo = createConversation(db, { bookId: book.id });
    const a = appendMessage(db, {
      conversationId: convo.id,
      role: "assistant",
      parts: [{ type: "text", text: "a" }],
    });
    expect(
      (await runResend(deps, { conversationId: convo.id, userMessageId: "nope", userText: "x" }))
        .ok,
    ).toBe(false);
    expect(
      (await runResend(deps, { conversationId: convo.id, userMessageId: a.id, userText: "x" })).ok,
    ).toBe(false); // assistant
  });

  it("truncates after the user message and streams a fresh assistant reply", async () => {
    const { db, book, deps } = await setup({
      ok: true,
      model: textStreamModel("regenerated"),
      modelId: "mock",
    });
    const convo = await seedTurn(deps, db, book.id);
    const msgs = listMessages(db, convo.id);
    const user = msgs.find((m) => m.role === "user")!;
    const r = await runResend(deps, {
      conversationId: convo.id,
      userMessageId: user.id,
      userText: "first question",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;
    const after = listMessages(db, convo.id);
    expect(after.map((m) => m.role)).toEqual(["user", "assistant"]); // old assistant replaced, no dup user
    const assistantText = after[1].parts
      .filter((p): p is { type: "text"; text: string } => p.type === "text")
      .map((p) => p.text)
      .join("");
    expect(assistantText).toContain("regenerated");
  });

  it("applies the edited user text and sends it to the model", async () => {
    const captured: { system?: string; texts: string[] } = { texts: [] };
    const { db, book, deps } = await setup({
      ok: true,
      model: promptCapturingModel(captured),
      modelId: "mock",
    });
    const convo = await seedTurn(deps, db, book.id);
    const user = listMessages(db, convo.id).find((m) => m.role === "user")!;
    const r = await runResend(deps, {
      conversationId: convo.id,
      userMessageId: user.id,
      userText: "EDITED QUESTION",
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    await r.finished;
    expect(getMessage(db, user.id)?.parts).toEqual([{ type: "text", text: "EDITED QUESTION" }]);
    expect(captured.texts.join("\n")).toContain("EDITED QUESTION");
  });
});
