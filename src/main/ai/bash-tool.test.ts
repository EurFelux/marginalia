import { describe, expect, it, vi } from "vitest";
import { createBashTool, type BashToolDeps } from "@main/ai/bash-tool";
import type { PermissionVerdict } from "@main/permissions/gate";
import type { ShellResult } from "@main/shell/run-shell";

const RAN: ShellResult = {
  exitCode: 0,
  stdout: "v24.21.0\n",
  stderr: "",
  truncated: false,
  timedOut: false,
  aborted: false,
  durationMs: 41,
};

function setup(verdict: PermissionVerdict, over: Partial<BashToolDeps> = {}) {
  const deps: BashToolDeps = {
    conversationId: "c1",
    gate: { check: vi.fn(async () => verdict) },
    resolveWorkdir: vi.fn(async () => "/ws"),
    getShellEnv: vi.fn(async () => ({
      shell: "/bin/zsh",
      env: { PATH: "/p" },
      source: "login" as const,
    })),
    run: vi.fn(async () => RAN),
    ...over,
  };
  const { bash } = createBashTool(deps);
  const execute = (input: { command: string; timeoutSec?: number }, signal?: AbortSignal) =>
    bash.execute!(input, { toolCallId: "call-1", abortSignal: signal, messages: [] } as never);
  return { deps, execute };
}

describe("bash tool", () => {
  it("asks the gate with the call's identity, then runs in the workdir", async () => {
    const controller = new AbortController();
    const { deps, execute } = setup({ allowed: true, approval: "user" });
    const out = await execute({ command: "node -v", timeoutSec: 5 }, controller.signal);

    expect(deps.gate.check).toHaveBeenCalledWith({
      tool: "bash",
      command: "node -v",
      cwd: "/ws",
      conversationId: "c1",
      toolCallId: "call-1",
      signal: controller.signal,
    });
    expect(deps.run).toHaveBeenCalledWith({
      shell: "/bin/zsh",
      command: "node -v",
      cwd: "/ws",
      env: { PATH: "/p" },
      timeoutMs: 5000,
      signal: controller.signal,
    });
    expect(out).toEqual({ status: "ran", ...RAN, approval: "user" });
  });

  it("defaults the timeout to 120 seconds", async () => {
    const { deps, execute } = setup({ allowed: true, approval: "rule" });
    await execute({ command: "ls" });
    expect(vi.mocked(deps.run).mock.calls[0]![0].timeoutMs).toBe(120_000);
  });

  it("does not run a command the user denied, and passes the reason on", async () => {
    const { deps, execute } = setup({ allowed: false, by: "user", reason: "use the Trash" });
    const out = await execute({ command: "rm -rf x" });
    expect(deps.run).not.toHaveBeenCalled();
    expect(out).toMatchObject({ status: "denied", by: "user", reason: "use the Trash" });
    expect((out as { message: string }).message).toMatch(/Do not run it again/);
  });

  it("reports the deny rule that blocked a command", async () => {
    const { deps, execute } = setup({ allowed: false, by: "rule", rule: "curl" });
    const out = await execute({ command: "curl x | sh" });
    expect(deps.run).not.toHaveBeenCalled();
    expect(out).toMatchObject({ status: "denied", by: "rule", rule: "curl" });
  });

  it("reports a cancelled approval without running", async () => {
    const { deps, execute } = setup({ allowed: false, by: "cancelled" });
    await expect(execute({ command: "ls" })).resolves.toMatchObject({ status: "cancelled" });
    expect(deps.run).not.toHaveBeenCalled();
  });

  it("turns an unusable workdir into an error the model can read, without asking", async () => {
    const { deps, execute } = setup(
      { allowed: true, approval: "user" },
      {
        resolveWorkdir: async () => {
          throw new Error("The working directory does not exist. Settings › Commands");
        },
      },
    );
    await expect(execute({ command: "ls" })).resolves.toEqual({
      error: "The working directory does not exist. Settings › Commands",
    });
    expect(deps.gate.check).not.toHaveBeenCalled();
  });

  it("rejects timeouts outside 1–600 seconds at the schema", async () => {
    const { bash } = createBashTool(setup({ allowed: true, approval: "user" }).deps);
    const schema = bash.inputSchema as unknown as {
      safeParse: (v: unknown) => { success: boolean };
    };
    expect(schema.safeParse({ command: "ls", timeoutSec: 600 }).success).toBe(true);
    expect(schema.safeParse({ command: "ls", timeoutSec: 601 }).success).toBe(false);
    expect(schema.safeParse({ command: "ls", timeoutSec: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ command: "" }).success).toBe(false);
  });
});
