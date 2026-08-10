import { describe, expect, it, vi } from "vitest";
import {
  investigateConversation,
  type ConversationInvestigation,
} from "@main/reading-report/investigator";
import {
  SESSION_CONVERSATION_MAX_LIMIT,
  type SessionConversationMessage,
  type SessionConversationReadOptions,
  type SessionConversationReadResult,
} from "@main/reading-report/evidence";

function message(seq: number, text: string): SessionConversationMessage {
  return {
    id: `message-${seq}`,
    role: seq % 2 === 0 ? "user" : "assistant",
    text,
    status: "complete",
    seq,
    createdAt: 0,
    context: "session",
    truncated: false,
  };
}

function messagePage(
  seqs: number[],
  options: { hasMore?: boolean; text?: string } = {},
): SessionConversationReadResult {
  return {
    status: "messages",
    compactedContext: null,
    messages: seqs.map((seq) => message(seq, options.text ?? `turn ${seq}`)),
    hasMore: options.hasMore ?? false,
    nextAfterSeq: options.hasMore ? Math.max(...seqs) : null,
  };
}

function pointsJson(points: Array<{ seqFrom: number; seqTo: number; text?: string }>): string {
  return JSON.stringify({
    topic: "determinism",
    points: points.map((point) => ({
      kind: "judgment",
      text: point.text ?? "the reader pushed back",
      quote: null,
      ...point,
    })),
  });
}

describe("conversation investigation", () => {
  it("pages through the whole conversation and merges points across pages", async () => {
    const readPage = vi
      .fn()
      .mockReturnValueOnce(messagePage([0, 1], { hasMore: true }))
      .mockReturnValueOnce(messagePage([2, 3], { hasMore: false }));
    const generate = vi
      .fn()
      .mockResolvedValueOnce(pointsJson([{ seqFrom: 0, seqTo: 1, text: "first" }]))
      .mockResolvedValueOnce(pointsJson([{ seqFrom: 2, seqTo: 3, text: "second" }]));

    const result = await investigateConversation({ readPage, generate });

    expect(readPage.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ afterSeq: undefined }));
    expect(readPage.mock.calls[1]?.[0]).toEqual(expect.objectContaining({ afterSeq: 1 }));
    expect(result.points.map((point) => point.text)).toEqual(["first", "second"]);
    expect(result.coverage).toEqual({
      fromSeq: 0,
      toSeq: 3,
      messagesRead: 4,
      truncated: false,
    });
  });

  it("keeps each model call scoped to a single page rather than the accumulated transcript", async () => {
    const readPage = vi
      .fn()
      .mockReturnValueOnce(messagePage([0], { hasMore: true, text: "PAGE ONE BODY" }))
      .mockReturnValueOnce(messagePage([1], { hasMore: false, text: "PAGE TWO BODY" }));
    const generate = vi.fn().mockResolvedValue(pointsJson([{ seqFrom: 0, seqTo: 0 }]));

    await investigateConversation({ readPage, generate });

    // 第二次调用不得夹带第一页原文——否则长会话只是把上下文爆点从主 agent 挪到 subagent。
    expect(generate.mock.calls[1]?.[0]).not.toContain("PAGE ONE BODY");
    expect(generate.mock.calls[1]?.[0]).toContain("PAGE TWO BODY");
  });

  it("stops and reports truncation once the cumulative token budget is spent", async () => {
    const readPage = vi.fn((_options: SessionConversationReadOptions) =>
      messagePage([0, 1], { hasMore: true, text: "喵".repeat(400) }),
    );
    const generate = vi.fn().mockResolvedValue(pointsJson([{ seqFrom: 0, seqTo: 1 }]));

    const result = await investigateConversation({
      readPage,
      generate,
      totalTokenBudget: 1_000,
      pageTokenBudget: 400,
    });

    expect(result.coverage.truncated).toBe(true);
    // 每页约 800 token，1000 的总预算最多容下两页。
    expect(readPage.mock.calls.length).toBeLessThanOrEqual(2);
  });

  it("lets the token budget, not the message count, bound a page", async () => {
    const readPage = vi.fn((_options: SessionConversationReadOptions) =>
      messagePage([0], { hasMore: false }),
    );
    const generate = vi.fn().mockResolvedValue(pointsJson([{ seqFrom: 0, seqTo: 0 }]));

    await investigateConversation({ readPage, generate });

    // 条数上限若先触发，短问短答的会话会被切成远小于 token 预算的碎片。
    const request = readPage.mock.calls[0]?.[0];
    expect(request?.limit).toBeGreaterThan(SESSION_CONVERSATION_MAX_LIMIT);
    expect(request?.maxLimit).toBe(request?.limit);
  });

  it("caps a page budget request at the remaining cumulative budget", async () => {
    const readPage = vi.fn((_options: SessionConversationReadOptions) =>
      messagePage([0], { hasMore: false }),
    );
    const generate = vi.fn().mockResolvedValue(pointsJson([{ seqFrom: 0, seqTo: 0 }]));

    await investigateConversation({
      readPage,
      generate,
      totalTokenBudget: 500,
      pageTokenBudget: 40_000,
    });

    expect(readPage.mock.calls[0]?.[0]).toEqual(expect.objectContaining({ tokenBudget: 500 }));
  });

  it("clamps out-of-range seq references to the page actually read", async () => {
    const readPage = vi.fn((_options: SessionConversationReadOptions) =>
      messagePage([4, 5], { hasMore: false }),
    );
    const generate = vi.fn().mockResolvedValue(pointsJson([{ seqFrom: 0, seqTo: 900 }]));

    const result = await investigateConversation({ readPage, generate });

    expect(result.points[0]).toEqual(expect.objectContaining({ seqFrom: 4, seqTo: 5 }));
  });

  it("skips a page whose output does not parse but keeps the rest", async () => {
    const readPage = vi
      .fn()
      .mockReturnValueOnce(messagePage([0], { hasMore: true }))
      .mockReturnValueOnce(messagePage([1], { hasMore: false }));
    const generate = vi
      .fn()
      .mockResolvedValueOnce("sorry, I cannot help with that")
      .mockResolvedValueOnce(pointsJson([{ seqFrom: 1, seqTo: 1, text: "survived" }]));

    const result = await investigateConversation({ readPage, generate });

    expect(result.points.map((point) => point.text)).toEqual(["survived"]);
  });

  it("fails when no page produced parseable output", async () => {
    const readPage = vi.fn((_options: SessionConversationReadOptions) =>
      messagePage([0], { hasMore: false }),
    );
    const generate = vi.fn().mockResolvedValue("no json here");

    await expect(investigateConversation({ readPage, generate })).rejects.toThrow(
      /no parseable output/,
    );
  });

  it("passes the compacted summary as background and stops on a compacted-only page", async () => {
    const readPage = vi.fn(
      (): SessionConversationReadResult => ({
        status: "compacted-only",
        compactedContext: { summary: "EARLIER GROUND", throughSeq: 9 },
        messages: [],
      }),
    );
    const generate = vi.fn();

    const result: ConversationInvestigation = await investigateConversation({
      readPage,
      generate,
    });

    expect(generate).not.toHaveBeenCalled();
    expect(result.coverage).toEqual({
      fromSeq: null,
      toSeq: null,
      messagesRead: 0,
      truncated: false,
    });
  });

  it("forwards the caller's focus to the model", async () => {
    const readPage = vi.fn((_options: SessionConversationReadOptions) =>
      messagePage([0], { hasMore: false }),
    );
    const generate = vi.fn().mockResolvedValue(pointsJson([{ seqFrom: 0, seqTo: 0 }]));

    await investigateConversation({ readPage, generate, focus: "why they rejected the framing" });

    expect(generate.mock.calls[0]?.[0]).toContain("why they rejected the framing");
  });
});
