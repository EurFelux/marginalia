import { describe, expect, it } from "vitest";
import type { MessageDto } from "@shared/chat";
import { planFold } from "@main/ai/context-compaction";

/** 构造最小 MessageDto（planFold 只用 seq/role；其余补齐以满足类型）。 */
function msg(seq: number, role: "user" | "assistant"): MessageDto {
  return {
    id: `m${seq}`,
    conversationId: "c",
    role,
    parts: [{ type: "text", text: `t${seq}` }],
    metadata: null,
    status: "complete",
    seq,
    createdAt: 0,
  };
}

/** seq 0,1,2,... 交替 user/assistant，共 n 条。 */
function tail(n: number, startSeq = 0): MessageDto[] {
  return Array.from({ length: n }, (_, i) =>
    msg(startSeq + i, (startSeq + i) % 2 === 0 ? "user" : "assistant"),
  );
}

const each10 = () => 10; // 每条 10 token

describe("planFold", () => {
  it("returns null when the tail estimate is at or below the high-water", () => {
    expect(planFold(tail(4), each10, { high: 100, low: 20, minRecent: 2 })).toBeNull();
  });

  it("folds the oldest exchanges down toward the low-water, on an assistant boundary", () => {
    const plan = planFold(tail(8), each10, { high: 1, low: 25, minRecent: 2 });
    expect(plan).not.toBeNull();
    expect(plan!.foldThroughSeq).toBe(5);
    expect(plan!.foldedTurns.map((m) => m.seq)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("never folds below the minRecent floor even if the low-water wants more", () => {
    const plan = planFold(tail(8), each10, { high: 1, low: 5, minRecent: 4 });
    expect(plan!.foldedTurns.map((m) => m.seq)).toEqual([0, 1, 2, 3]);
    expect(plan!.foldThroughSeq).toBe(3);
  });

  it("aligns the kept region to a user boundary (keeps one more rather than splitting a pair)", () => {
    const plan = planFold(tail(6), each10, { high: 1, low: 5, minRecent: 3 });
    expect(plan!.foldedTurns.map((m) => m.seq)).toEqual([0, 1]);
    expect(plan!.foldThroughSeq).toBe(1);
  });
});
