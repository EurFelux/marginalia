import { tool } from "ai";
import { z } from "zod";
import { describe, expect, it } from "vitest";
import type { ProgressSink } from "@main/reading-report/runtime";
import { progressCount, progressOutcome, withProgress } from "@main/reading-report/progress";

interface Event {
  id: string;
  tool: string;
  outcome: string | null;
  count: number | null;
}

function recordingSink() {
  const events: Event[] = [];
  let next = 0;
  const sink: ProgressSink = {
    start: (name) => {
      const id = String(++next);
      events.push({ id, tool: name, outcome: null, count: null });
      return id;
    },
    finish: (id, outcome, count) => {
      const event = events.find((entry) => entry.id === id);
      if (event) {
        event.outcome = outcome;
        event.count = count;
      }
    },
  };
  return { sink, events };
}

const noInput = z.object({});

describe("progressCount", () => {
  it("reads items, then messages, and gives up otherwise", () => {
    expect(progressCount({ items: [1, 2, 3], hasMore: false })).toEqual(3);
    expect(progressCount({ messages: [1, 2], hasMore: true })).toEqual(2);
    expect(progressCount({ activeSeconds: 90 })).toBeNull();
    expect(progressCount("plain text")).toBeNull();
    expect(progressCount(null)).toBeNull();
  });
});

describe("progressOutcome", () => {
  it("treats swallowed tool errors and delegation fallbacks as skipped", () => {
    expect(progressOutcome({ items: [] })).toEqual("ok");
    expect(progressOutcome({ error: "conversation not found" })).toEqual("skipped");
    expect(progressOutcome({ status: "busy", suggestion: "read it yourself" })).toEqual("skipped");
    expect(progressOutcome({ status: "failed", suggestion: "read it yourself" })).toEqual(
      "skipped",
    );
    expect(progressOutcome({ status: "ok", highlights: [] })).toEqual("ok");
  });
});

describe("withProgress", () => {
  it("passes the tool output through untouched while reporting a finished step", async () => {
    const { sink, events } = recordingSink();
    const wrapped = withProgress(
      {
        listAnnotations: tool({
          description: "list",
          inputSchema: noInput,
          execute: async () => ({ items: [1, 2, 3], hasMore: false }),
        }),
      },
      sink,
    );

    const output = await wrapped.listAnnotations.execute!({}, {} as never);

    expect(output).toEqual({ items: [1, 2, 3], hasMore: false });
    expect(events).toEqual([{ id: "1", tool: "listAnnotations", outcome: "ok", count: 3 }]);
  });

  it("still finishes the step when the tool throws, and rethrows", async () => {
    const { sink, events } = recordingSink();
    const wrapped = withProgress(
      {
        readConversation: tool({
          description: "read",
          inputSchema: noInput,
          // 显式标注返回类型：只抛错的 execute 会被推成 Promise<never>，令 tool() 的重载失配。
          execute: async (): Promise<{ messages: number[] }> => {
            throw new Error("boom");
          },
        }),
      },
      sink,
    );

    await expect(wrapped.readConversation.execute!({}, {} as never)).rejects.toThrow("boom");
    expect(events).toEqual([
      { id: "1", tool: "readConversation", outcome: "skipped", count: null },
    ]);
  });

  it("reports concurrent calls as separate steps", async () => {
    const { sink, events } = recordingSink();
    const wrapped = withProgress(
      {
        investigateConversation: tool({
          description: "investigate",
          inputSchema: noInput,
          execute: async () => ({ status: "ok", highlights: [] }),
        }),
      },
      sink,
    );

    await Promise.all([
      wrapped.investigateConversation.execute!({}, {} as never),
      wrapped.investigateConversation.execute!({}, {} as never),
    ]);

    expect(events.map((event) => event.id)).toEqual(["1", "2"]);
    expect(events.every((event) => event.outcome === "ok")).toBe(true);
  });

  it("leaves a tool without execute alone", () => {
    const { sink } = recordingSink();
    const bare = { note: tool({ description: "no execute", inputSchema: noInput }) };
    const wrapped = withProgress(bare, sink);
    expect(wrapped.note).toBe(bare.note);
  });
});
