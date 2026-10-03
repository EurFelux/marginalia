import { describe, expect, it } from "vitest";
import {
  captureLoginEnv,
  defaultShell,
  fallbackEnv,
  loginEnvCommand,
  parseEnvOutput,
  resolveShellEnv,
  sanitizeEnv,
} from "@main/shell/login-env";

/** 模拟登录 shell 的输出：启动脚本的杂讯包在标记外面。 */
function shellOutput(env: Record<string, string>, noise = "\x1b[32mexec zsh\x1b[39m\nWelcome!\n") {
  const marker = loginEnvCommand().match(/printf %s (\S+);/)![1]!;
  const body = Object.entries(env)
    .map(([k, v]) => `${k}=${v}\0`)
    .join("");
  return `${noise}${marker}${body}${marker}${noise}`;
}

describe("parseEnvOutput", () => {
  it("reads NUL-separated pairs between the markers and ignores startup noise", () => {
    const out = shellOutput({ PATH: "/opt/homebrew/bin:/usr/bin", MULTI: "a\nb=c", EMPTY: "" });
    expect(parseEnvOutput(out)).toEqual({
      PATH: "/opt/homebrew/bin:/usr/bin",
      MULTI: "a\nb=c",
      EMPTY: "",
    });
  });

  it("returns null without a complete pair of markers", () => {
    expect(parseEnvOutput("PATH=/usr/bin\0")).toBeNull();
    const out = shellOutput({ PATH: "/x" });
    expect(parseEnvOutput(out.slice(0, out.lastIndexOf("__")))).toBeNull();
  });
});

describe("sanitizeEnv", () => {
  it("drops Electron variables and disables pagers and colors", () => {
    expect(
      sanitizeEnv({ PATH: "/usr/bin", ELECTRON_RUN_AS_NODE: "1", PAGER: "less", UNSET: undefined }),
    ).toEqual({ PATH: "/usr/bin", PAGER: "cat", GIT_PAGER: "cat", NO_COLOR: "1", TERM: "dumb" });
  });
});

describe("fallbackEnv", () => {
  it("appends missing Homebrew paths once", () => {
    expect(fallbackEnv({ PATH: "/usr/bin:/bin" }).PATH).toBe(
      "/usr/bin:/bin:/opt/homebrew/bin:/usr/local/bin",
    );
    expect(fallbackEnv({ PATH: "/usr/local/bin:/usr/bin" }).PATH).toBe(
      "/usr/local/bin:/usr/bin:/opt/homebrew/bin",
    );
    expect(fallbackEnv({}).PATH).toBe("/opt/homebrew/bin:/usr/local/bin");
  });
});

describe("defaultShell", () => {
  it("uses an absolute $SHELL, else the platform default", () => {
    expect(defaultShell("darwin", "/opt/homebrew/bin/fish")).toBe("/opt/homebrew/bin/fish");
    expect(defaultShell("darwin", undefined)).toBe("/bin/zsh");
    expect(defaultShell("linux", "")).toBe("/bin/bash");
    expect(defaultShell("linux", "zsh")).toBe("/bin/bash");
  });
});

describe("resolveShellEnv", () => {
  it("uses the login shell environment when it parses", async () => {
    const env = await resolveShellEnv({
      shell: "/bin/zsh",
      processEnv: { PATH: "/usr/bin" },
      capture: async () => shellOutput({ PATH: "/Users/me/.local/share/mise/shims:/usr/bin" }),
    });
    expect(env.source).toBe("login");
    expect(env.env.PATH).toBe("/Users/me/.local/share/mise/shims:/usr/bin");
  });

  it("falls back when the login shell fails or prints nothing usable", async () => {
    for (const capture of [
      async () => {
        throw new Error("timeout");
      },
      async () => "no markers here",
    ]) {
      const env = await resolveShellEnv({
        shell: "/bin/zsh",
        processEnv: { PATH: "/usr/bin" },
        capture,
      });
      expect(env.source).toBe("fallback");
      expect(env.env.PATH).toBe("/usr/bin:/opt/homebrew/bin:/usr/local/bin");
    }
  });
});

describe("captureLoginEnv", () => {
  it("captures a real login shell's environment", async () => {
    const parsed = parseEnvOutput(await captureLoginEnv("/bin/sh"));
    expect(parsed?.PATH).toBeTruthy();
  });

  it("rejects when the shell does not exist", async () => {
    await expect(captureLoginEnv("/nonexistent/shell")).rejects.toThrow();
  });
});
