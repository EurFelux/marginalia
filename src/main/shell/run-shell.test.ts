import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runShell, stripAnsi, type RunShellOptions } from "@main/shell/run-shell";

const cwd = realpathSync(mkdtempSync(path.join(tmpdir(), "run-shell-")));

const run = (command: string, over: Partial<RunShellOptions> = {}) =>
  runShell({
    shell: "/bin/sh",
    command,
    cwd,
    env: { PATH: "/usr/bin:/bin", FOO: "bar" },
    timeoutMs: 10_000,
    ...over,
  });

/** 用独特的 sleep 时长找出遗留进程。 */
function alive(marker: string): boolean {
  try {
    execFileSync("pgrep", ["-f", marker]);
    return true;
  } catch {
    return false;
  }
}

describe("runShell", () => {
  it("captures stdout, stderr and the exit code", async () => {
    const r = await run("echo out; echo err >&2; exit 3");
    expect(r).toMatchObject({
      exitCode: 3,
      stdout: "out\n",
      stderr: "err\n",
      truncated: false,
      timedOut: false,
      aborted: false,
    });
    expect(Number.isInteger(r.durationMs)).toBe(true);
  });

  it("runs in the given cwd with the given env", async () => {
    const r = await run('pwd; echo "$FOO"');
    expect(r.stdout).toBe(`${cwd}\nbar\n`);
  });

  it("closes stdin so reads end immediately", async () => {
    const r = await run("cat; echo done");
    expect(r.stdout).toBe("done\n");
  });

  it("times out and kills the whole process group", async () => {
    const r = await run("sleep 31.11 & sleep 31.12", { timeoutMs: 200 });
    expect(r).toMatchObject({ timedOut: true, exitCode: null, aborted: false });
    expect(r.durationMs).toBeLessThan(3000);
    expect(alive("sleep 31.11")).toBe(false);
    expect(alive("sleep 31.12")).toBe(false);
  });

  it("escalates to SIGKILL when the command ignores SIGTERM", async () => {
    const r = await run("trap '' TERM; sleep 31.21", { timeoutMs: 100, killGraceMs: 200 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeLessThan(3000);
    expect(alive("sleep 31.21")).toBe(false);
  });

  it("stops on abort and returns what it has", async () => {
    const controller = new AbortController();
    setTimeout(() => controller.abort(), 150);
    const r = await run("echo started; sleep 31.31", { signal: controller.signal });
    expect(r).toMatchObject({
      aborted: true,
      timedOut: false,
      exitCode: null,
      stdout: "started\n",
    });
    expect(alive("sleep 31.31")).toBe(false);
  });

  it("does not start when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await run("touch should-not-exist", { signal: controller.signal });
    expect(r.aborted).toBe(true);
    expect(existsSync(path.join(cwd, "should-not-exist"))).toBe(false);
  });

  it("cleans up background processes left after a normal exit", async () => {
    const r = await run("(sleep 31.41 >/dev/null 2>&1 &); echo hi");
    expect(r.stdout).toBe("hi\n");
    await new Promise((res) => setTimeout(res, 100));
    expect(alive("sleep 31.41")).toBe(false);
  });

  it("keeps the head and tail of long output", async () => {
    const r = await run(
      "printf 'H%.0s' $(seq 1 100); head -c 100000 /dev/zero | tr '\\0' a; printf T",
      {
        maxOutputChars: 1000,
      },
    );
    expect(r.truncated).toBe(true);
    expect(r.stdout.startsWith("H".repeat(100))).toBe(true);
    expect(r.stdout.endsWith("aT")).toBe(true);
    expect(r.stdout).toContain("characters omitted");
    expect(r.stdout.length).toBeLessThan(1100);
  });

  it("gives stderr at most a third of the budget when both overflow", async () => {
    const r = await run(
      "head -c 5000 /dev/zero | tr '\\0' o; head -c 5000 /dev/zero | tr '\\0' e >&2",
      { maxOutputChars: 900 },
    );
    expect(r.truncated).toBe(true);
    expect(r.stderr.replace(/\n… \[\d+ characters omitted\] …\n/, "")).toHaveLength(300);
    expect(r.stdout.replace(/\n… \[\d+ characters omitted\] …\n/, "")).toHaveLength(600);
  });

  it("strips ANSI escape sequences", async () => {
    const r = await run("printf '\\033[31mred\\033[0m'");
    expect(r.stdout).toBe("red");
    expect(stripAnsi("\x1b]8;;https://x\x07link\x1b]8;;\x07")).toBe("link");
  });

  it("rejects when the cwd does not exist", async () => {
    await expect(run("pwd", { cwd: path.join(cwd, "missing") })).rejects.toThrow();
  });
});
