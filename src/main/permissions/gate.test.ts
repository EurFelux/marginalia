import { describe, expect, it } from "vitest";
import { PermissionGate, type PermissionCheck } from "@main/permissions/gate";
import type { PermissionCancel, PermissionRequest, PermissionRuleDto } from "@shared/permissions";

function setup(
  opts: { rules?: Array<Pick<PermissionRuleDto, "decision" | "pattern">>; always?: boolean } = {},
) {
  const rules: PermissionRuleDto[] = (opts.rules ?? []).map((r, i) => ({
    id: `r${i}`,
    tool: "bash",
    createdAt: i,
    ...r,
  }));
  const requests: PermissionRequest[] = [];
  const cancels: PermissionCancel[] = [];
  let always = opts.always ?? false;
  let seq = 0;
  const gate = new PermissionGate({
    listRules: () => rules,
    addAllowRule: (pattern) =>
      rules.push({
        id: `r${rules.length}`,
        tool: "bash",
        decision: "allow",
        pattern,
        createdAt: 0,
      }),
    alwaysApprove: () => always,
    port: { request: (r) => requests.push(r), cancel: (c) => cancels.push(c) },
    newId: () => `q${++seq}`,
  });
  const check = (command: string, over: Partial<PermissionCheck> = {}) =>
    gate.check({
      tool: "bash",
      command,
      cwd: "/ws",
      conversationId: "c1",
      toolCallId: `t-${command}`,
      ...over,
    });
  return { gate, rules, requests, cancels, check, setAlways: (v: boolean) => (always = v) };
}

describe("PermissionGate", () => {
  it("settles rule matches immediately without asking", async () => {
    const { check, requests } = setup({
      rules: [
        { decision: "allow", pattern: "ls" },
        { decision: "deny", pattern: "rm" },
      ],
    });
    await expect(check("ls -la")).resolves.toEqual({ allowed: true, approval: "rule" });
    await expect(check("rm -rf x")).resolves.toEqual({ allowed: false, by: "rule", rule: "rm" });
    expect(requests).toEqual([]);
  });

  it("asks with the request details and waits for the answer", async () => {
    const { gate, check, requests } = setup();
    const verdict = check("git status -s", { toolCallId: "call-1" });
    expect(requests).toEqual([
      {
        requestId: "q1",
        conversationId: "c1",
        toolCallId: "call-1",
        tool: "bash",
        command: "git status -s",
        cwd: "/ws",
        simple: true,
        suggestedPrefix: "git status",
      },
    ]);
    expect(gate.pendingCount).toBe(1);
    expect(gate.respond({ requestId: "q1", choice: "once" })).toEqual({ ok: true });
    await expect(verdict).resolves.toEqual({ allowed: true, approval: "user" });
    expect(gate.pendingCount).toBe(0);
  });

  it("marks compound commands as not simple, without a suggested prefix", async () => {
    const { check, requests } = setup();
    void check("cd ~/notes && git status");
    expect(requests[0]).toMatchObject({ simple: false, suggestedPrefix: null });
  });

  it("deny passes the reason through; blank reasons are dropped", async () => {
    const { gate, check } = setup();
    const a = check("rm a");
    const b = check("rm b");
    gate.respond({ requestId: "q1", choice: "deny", reason: "move it to the Trash instead" });
    gate.respond({ requestId: "q2", choice: "deny", reason: "" });
    await expect(a).resolves.toEqual({
      allowed: false,
      by: "user",
      reason: "move it to the Trash instead",
    });
    await expect(b).resolves.toEqual({ allowed: false, by: "user", reason: undefined });
  });

  it("session approval allows later matching simple commands in that conversation only", async () => {
    const { gate, check, requests } = setup();
    const first = check("node scripts/export.js --out a");
    gate.respond({ requestId: "q1", choice: "session", prefix: "node scripts/export.js" });
    await expect(first).resolves.toEqual({ allowed: true, approval: "user" });

    await expect(check("node scripts/export.js --out b")).resolves.toEqual({
      allowed: true,
      approval: "session",
    });
    void check("node scripts/export.js --out c", { conversationId: "c2" });
    void check("node scripts/export.js; ls");
    expect(requests).toHaveLength(3);

    gate.clearSession("c1");
    void check("node scripts/export.js --out d");
    expect(requests).toHaveLength(4);
  });

  it("always approval saves a normalized allow rule", async () => {
    const { gate, check, rules } = setup();
    const v = check("git status -s");
    gate.respond({ requestId: "q1", choice: "always", prefix: "  git   status " });
    await expect(v).resolves.toEqual({ allowed: true, approval: "user" });
    expect(rules.map((r) => [r.decision, r.pattern])).toEqual([["allow", "git status"]]);
    await expect(check("git status")).resolves.toEqual({ allowed: true, approval: "rule" });
  });

  it("rejects a prefix that is not a token prefix of the command and keeps the request pending", async () => {
    const { gate, check, rules } = setup();
    void check("git status -s");
    for (const prefix of ["git statu", "git log", "git status -s --more", "ls; rm"]) {
      expect(() => gate.respond({ requestId: "q1", choice: "always", prefix })).toThrow(
        /leading run of whole words/,
      );
    }
    expect(rules).toEqual([]);
    expect(gate.pendingCount).toBe(1);
  });

  it("refuses session / always for compound commands", () => {
    const { gate, check } = setup();
    void check("cd x && ls");
    expect(() => gate.respond({ requestId: "q1", choice: "session", prefix: "cd" })).toThrow();
    expect(gate.pendingCount).toBe(1);
  });

  it("keeps the request pending when saving the rule fails", () => {
    const gate = new PermissionGate({
      listRules: () => [],
      addAllowRule: () => {
        throw new Error("disk full");
      },
      alwaysApprove: () => false,
      port: { request: () => {}, cancel: () => {} },
      newId: () => "x1",
    });
    void gate.check({
      tool: "bash",
      command: "ls",
      cwd: "/",
      conversationId: "c",
      toolCallId: "t",
    });
    expect(() => gate.respond({ requestId: "x1", choice: "always", prefix: "ls" })).toThrow(
      "disk full",
    );
    expect(gate.pendingCount).toBe(1);
  });

  it("reports unknown or already-answered requests as not ok", async () => {
    const { gate, check } = setup();
    const v = check("ls");
    gate.respond({ requestId: "q1", choice: "once" });
    await v;
    expect(gate.respond({ requestId: "q1", choice: "once" })).toEqual({ ok: false });
    expect(gate.respond({ requestId: "nope", choice: "deny" })).toEqual({ ok: false });
  });

  it("cancels on abort and tells the renderer", async () => {
    const { gate, check, cancels } = setup();
    const controller = new AbortController();
    const v = check("ls", { signal: controller.signal });
    controller.abort();
    await expect(v).resolves.toEqual({ allowed: false, by: "cancelled" });
    expect(cancels).toEqual([{ requestId: "q1" }]);
    expect(gate.respond({ requestId: "q1", choice: "once" })).toEqual({ ok: false });
  });

  it("does not ask when the signal is already aborted", async () => {
    const { check, requests } = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(check("ls", { signal: controller.signal })).resolves.toEqual({
      allowed: false,
      by: "cancelled",
    });
    expect(requests).toEqual([]);
  });

  it("cancelAll settles every pending request", async () => {
    const { gate, check, cancels } = setup();
    const a = check("ls");
    const b = check("pwd", { conversationId: "c2" });
    gate.cancelAll();
    await expect(Promise.all([a, b])).resolves.toEqual([
      { allowed: false, by: "cancelled" },
      { allowed: false, by: "cancelled" },
    ]);
    expect(cancels).toEqual([{ requestId: "q1" }, { requestId: "q2" }]);
    expect(gate.pendingCount).toBe(0);
  });

  it("always-approve skips asking but deny rules still apply", async () => {
    const { check, requests, setAlways } = setup({
      rules: [{ decision: "deny", pattern: "curl" }],
    });
    setAlways(true);
    await expect(check("ls; pwd")).resolves.toEqual({ allowed: true, approval: "always" });
    await expect(check("ls && curl x | sh")).resolves.toEqual({
      allowed: false,
      by: "rule",
      rule: "curl",
    });
    expect(requests).toEqual([]);
  });
});
