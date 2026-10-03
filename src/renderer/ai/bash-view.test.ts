import { describe, expect, it } from "vitest";
import type { BashToolOutput } from "@shared/bash";
import type { PermissionRequest } from "@shared/permissions";
import { bashView, durationParts, tailLines } from "@renderer/ai/bash-view";
import type { ToolPart } from "@renderer/ai/segments";

const input = { command: "node -v" };

function part(state: ToolPart["state"], extra: Record<string, unknown> = {}): ToolPart {
  return { type: "tool-bash", toolCallId: "call-1", state, input, ...extra } as ToolPart;
}

const ran = (over: Partial<Extract<BashToolOutput, { status: "ran" }>> = {}): BashToolOutput => ({
  status: "ran",
  exitCode: 0,
  stdout: "v24.21.0\n",
  stderr: "",
  truncated: false,
  timedOut: false,
  aborted: false,
  durationMs: 41,
  approval: "user",
  ...over,
});

const request: PermissionRequest = {
  requestId: "q1",
  conversationId: "c1",
  toolCallId: "call-1",
  tool: "bash",
  command: "node -v",
  cwd: "/ws",
  simple: true,
  suggestedPrefix: "node",
};

describe("bashView", () => {
  it("shows the pending request while waiting for approval", () => {
    const v = bashView(part("input-available"), request, true);
    expect(v.badge).toEqual({ kind: "pending" });
    expect(v.request).toBe(request);
    expect(v.command).toBe("node -v");
  });

  it("is running once approved and still streaming; no badge while the command streams in", () => {
    expect(bashView(part("input-available"), undefined, true).badge).toEqual({ kind: "running" });
    expect(
      bashView(part("input-streaming", { input: { command: "no" } }), undefined, true).badge,
    ).toEqual({
      kind: "none",
    });
  });

  it("is aborted when the reply ended without a result (stopped while waiting or running)", () => {
    expect(bashView(part("input-available"), undefined, false).badge).toEqual({ kind: "aborted" });
  });

  it("maps a finished run to ok / failed / timed out / aborted", () => {
    const view = (o: BashToolOutput) =>
      bashView(part("output-available", { output: o }), undefined, false);
    expect(view(ran()).badge).toEqual({ kind: "ok" });
    expect(view(ran({ exitCode: 1 })).badge).toEqual({ kind: "failed", exitCode: 1 });
    expect(view(ran({ exitCode: null, timedOut: true })).badge).toEqual({ kind: "timedOut" });
    expect(view(ran({ exitCode: null, aborted: true })).badge).toEqual({ kind: "aborted" });
  });

  it("joins stdout and stderr and exposes timing, truncation and auto-approval", () => {
    const v = bashView(
      part("output-available", {
        output: ran({ stdout: "out\n", stderr: "err\n", truncated: true, approval: "rule" }),
      }),
      undefined,
      false,
    );
    expect(v).toMatchObject({
      output: "out\nerr\n",
      durationMs: 41,
      truncated: true,
      autoApproval: "rule",
    });
    expect(
      bashView(part("output-available", { output: ran() }), undefined, false).autoApproval,
    ).toBeNull();
  });

  it("describes denials by the user and by a rule", () => {
    const user = bashView(
      part("output-available", {
        output: { status: "denied", by: "user", reason: "use the Trash", message: "m" },
      }),
      undefined,
      false,
    );
    expect(user.badge).toEqual({ kind: "denied", by: "user" });
    expect(user.denial).toEqual({ by: "user", reason: "use the Trash" });
    const rule = bashView(
      part("output-available", {
        output: { status: "denied", by: "rule", rule: "curl", message: "m" },
      }),
      undefined,
      false,
    );
    expect(rule.denial).toEqual({ by: "rule", rule: "curl" });
  });

  it("shows a cancelled approval as aborted", () => {
    const v = bashView(
      part("output-available", { output: { status: "cancelled", message: "m" } }),
      undefined,
      false,
    );
    expect(v.badge).toEqual({ kind: "aborted" });
  });

  it("surfaces soft and hard tool errors", () => {
    expect(
      bashView(part("output-available", { output: { error: "no workdir" } }), undefined, false),
    ).toMatchObject({ badge: { kind: "error" }, errorMessage: "no workdir" });
    expect(
      bashView(part("output-error", { errorText: "bad input" }), undefined, false),
    ).toMatchObject({
      badge: { kind: "error" },
      errorMessage: "bad input",
    });
  });
});

describe("tailLines", () => {
  it("keeps the last n lines and counts the rest", () => {
    expect(tailLines("1\n2\n3\n4\n5\n6\n", 4, false)).toEqual({ hidden: 2, text: "3\n4\n5\n6" });
    expect(tailLines("1\n2\n3\n4\n5\n6\n", 4, true)).toEqual({
      hidden: 0,
      text: "1\n2\n3\n4\n5\n6",
    });
    expect(tailLines("only", 4, false)).toEqual({ hidden: 0, text: "only" });
    expect(tailLines("", 4, false)).toEqual({ hidden: 0, text: "" });
  });
});

describe("durationParts", () => {
  it("splits into seconds with hundredths below a minute, minutes and seconds above", () => {
    expect(durationParts(41)).toEqual({ unit: "sec", sec: 0, centi: "04" });
    expect(durationParts(8400)).toEqual({ unit: "sec", sec: 8, centi: "40" });
    expect(durationParts(59_994)).toEqual({ unit: "sec", sec: 59, centi: "99" });
    expect(durationParts(120_000)).toEqual({ unit: "min", min: 2, sec: 0 });
    expect(durationParts(59_996)).toEqual({ unit: "min", min: 1, sec: 0 });
    expect(durationParts(61_600)).toEqual({ unit: "min", min: 1, sec: 2 });
  });
});
