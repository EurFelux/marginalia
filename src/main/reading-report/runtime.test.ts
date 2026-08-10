import { describe, expect, it } from "vitest";
import { ReadingReportRuntime } from "@main/reading-report/runtime";

/** 固定时钟：每次读取推进 1000ms，让断言里的时间戳可预期。 */
function fakeClock(start = 1_000) {
  let now = start;
  return () => {
    const value = now;
    now += 1000;
    return value;
  };
}

describe("ReadingReportRuntime progress", () => {
  it("records a step from start to finish and exposes it on generating state", () => {
    const runtime = new ReadingReportRuntime(fakeClock());
    const claim = runtime.claim("s1", "initial")!;
    const sink = runtime.sink("s1", claim.generation);

    const id = sink.start("listAnnotations");
    expect(runtime.state("s1", null)).toEqual({
      status: "generating",
      startedAt: 1_000,
      progress: [
        {
          id,
          tool: "listAnnotations",
          startedAt: 2_000,
          endedAt: null,
          outcome: null,
          count: null,
        },
      ],
    });

    sink.finish(id, "ok", 24);
    expect(runtime.state("s1", null)).toEqual({
      status: "generating",
      startedAt: 1_000,
      progress: [
        {
          id,
          tool: "listAnnotations",
          startedAt: 2_000,
          endedAt: 3_000,
          outcome: "ok",
          count: 24,
        },
      ],
    });
  });

  it("keeps concurrent steps side by side", () => {
    const runtime = new ReadingReportRuntime(fakeClock());
    const claim = runtime.claim("s1", "initial")!;
    const sink = runtime.sink("s1", claim.generation);

    const first = sink.start("investigateConversation");
    const second = sink.start("investigateConversation");
    expect(first).not.toEqual(second);

    sink.finish(second, "skipped", null);
    const state = runtime.state("s1", null);
    expect(state.status).toEqual("generating");
    const steps = state.status === "generating" ? state.progress : [];
    expect(steps.map((step) => step.outcome)).toEqual([null, "skipped"]);
  });

  it("clears progress on claim, success, cancel and invalidate but keeps it on failure", () => {
    const runtime = new ReadingReportRuntime(fakeClock());

    const first = runtime.claim("s1", "initial")!;
    runtime.sink("s1", first.generation).start("listConversations");
    runtime.fail("s1", { kind: "initial" }, first.generation);
    const failed = runtime.state("s1", null);
    expect(failed.status).toEqual("generation-failed");
    expect(failed.status === "generation-failed" ? failed.progress.length : 0).toEqual(1);

    const second = runtime.claim("s1", "initial")!;
    expect(runtime.state("s1", null)).toEqual({
      status: "generating",
      startedAt: expect.any(Number),
      progress: [],
    });
    runtime.sink("s1", second.generation).start("listConversations");
    runtime.succeed("s1", second.generation);
    expect(runtime.state("s1", "# Report")).toEqual({ status: "ready", content: "# Report" });

    const third = runtime.claim("s1", "initial")!;
    runtime.sink("s1", third.generation).start("listConversations");
    runtime.cancel("s1");
    expect(runtime.state("s1", null)).toEqual({ status: "empty" });

    const fourth = runtime.claim("s1", "initial")!;
    runtime.sink("s1", fourth.generation).start("listConversations");
    runtime.invalidate("s1");
    expect(runtime.state("s1", null)).toEqual({ status: "empty" });
  });

  it("drops the oldest steps beyond the 50 entry cap", () => {
    const runtime = new ReadingReportRuntime(fakeClock());
    const claim = runtime.claim("s1", "initial")!;
    const sink = runtime.sink("s1", claim.generation);
    for (let i = 0; i < 60; i++) sink.start(`tool${i}`);

    const state = runtime.state("s1", null);
    const steps = state.status === "generating" ? state.progress : [];
    expect(steps).toHaveLength(50);
    expect(steps[0]?.tool).toEqual("tool10");
    expect(steps.at(-1)?.tool).toEqual("tool59");
  });

  it("ignores a sink bound to a superseded generation", () => {
    const runtime = new ReadingReportRuntime(fakeClock());
    const stale = runtime.claim("s1", "initial")!;
    const staleSink = runtime.sink("s1", stale.generation);
    runtime.invalidate("s1");
    const fresh = runtime.claim("s1", "initial")!;

    staleSink.start("listAnnotations");
    const state = runtime.state("s1", null);
    expect(state.status === "generating" ? state.progress : []).toEqual([]);
    expect(fresh.generation).toBeGreaterThan(stale.generation);
  });
});
