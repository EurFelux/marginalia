import { describe, expect, it } from "vitest";
import {
  analyzeCommand,
  formatPattern,
  isTokenPrefix,
  parsePattern,
  suggestPrefix,
} from "@main/permissions/command";

describe("analyzeCommand: simple commands", () => {
  it.each([
    ["ls -la", ["ls", "-la"]],
    ["git status -s", ["git", "status", "-s"]],
    ['node -e "console.log(1+1)"', ["node", "-e", "console.log(1+1)"]],
    ['git commit -m "fix; typo"', ["git", "commit", "-m", "fix; typo"]],
    ["'l''s'", ["ls"]],
    ["l\\s", ["ls"]],
    ["ls *.md", ["ls", "*.md"]],
    ["  ls   -la  ", ["ls", "-la"]],
  ])("%s", (command, tokens) => {
    const a = analyzeCommand(command);
    expect(a.simple).toBe(true);
    expect(a.tokens).toEqual(tokens);
    expect(a.segments).toEqual([tokens]);
  });
});

describe("analyzeCommand: never simple", () => {
  it.each([
    ["ls; pwd"],
    ["ls && rm -rf x"],
    ["cat a | sh"],
    ["a & b"],
    ["echo hi > f"],
    ["ls 2>&1"],
    ["(cd x && ls)"],
    ["cat <(ls)"],
    ["ls # comment"],
    // shell-quote 本身看不出来的三种：换行被当空白、反引号与双引号里的 $(…) 被当普通文本
    ["ls\nrm -rf x"],
    ["ls\r\nrm -rf x"],
    ["echo `rm x`"],
    ['echo "$(rm -rf x)"'],
    ["echo $HOME"],
    [""],
    ["   "],
  ])("%j", (command) => {
    const a = analyzeCommand(command);
    expect(a.simple).toBe(false);
    expect(a.tokens).toBeNull();
    expect(a.suggestedPrefix).toBeNull();
  });
});

describe("analyzeCommand: segments for deny rules", () => {
  it("splits on control operators", () => {
    expect(analyzeCommand("cd ~/notes && git status --short | head -3; pwd").segments).toEqual([
      ["cd", "~/notes"],
      ["git", "status", "--short"],
      ["head", "-3"],
      ["pwd"],
    ]);
  });

  it("surfaces commands hidden in newlines, backticks and $(…)", () => {
    const heads = (c: string) => analyzeCommand(c).segments.map((s) => s[0]);
    expect(heads("ls\nrm -rf x")).toEqual(["ls", "rm"]);
    expect(heads("echo `rm x`")).toEqual(["echo", "rm"]);
    expect(heads("echo $(rm -rf x)")).toContain("rm");
    expect(heads("x=$(id)")).toContain("id");
  });

  it("skips leading env assignments, for simple commands too", () => {
    expect(analyzeCommand("FOO=1 curl x").segments).toEqual([["curl", "x"]]);
    expect(analyzeCommand("FOO=1 curl x").tokens).toEqual(["FOO=1", "curl", "x"]);
    expect(analyzeCommand("FOO=1 BAR=2 rm -rf x; ls").segments).toEqual([
      ["rm", "-rf", "x"],
      ["ls"],
    ]);
  });
});

describe("suggestPrefix", () => {
  it.each([
    [["git", "status", "-s"], "git status"],
    [["ls", "-la"], "ls"],
    [["node", "-v"], "node"],
    [["git", "-C", "~/notes", "status"], "git"],
    [["node", "scripts/export.js", "--out", "x"], "node scripts/export.js"],
    [["pwd"], "pwd"],
    [["node", "my script.js"], "node 'my script.js'"],
  ])("%j → %s", (tokens, prefix) => {
    expect(suggestPrefix(tokens)).toBe(prefix);
  });

  it("is always a token prefix of the command", () => {
    for (const c of ["git -C ~/notes status", "node 'my script.js' --x", "ls *.md"]) {
      const a = analyzeCommand(c);
      expect(isTokenPrefix(parsePattern(a.suggestedPrefix!)!, a.tokens!)).toBe(true);
    }
  });
});

describe("patterns", () => {
  it("round-trips tokens that need quoting", () => {
    for (const tokens of [
      ["node", "my script.js"],
      ["ls", "*.md"],
      ["echo", "a;b"],
    ]) {
      expect(parsePattern(formatPattern(tokens))).toEqual(tokens);
    }
  });

  it("normalizes whitespace and quoting", () => {
    expect(formatPattern(parsePattern("  git    status ")!)).toBe("git status");
    expect(formatPattern(parsePattern("'git' \"status\"")!)).toBe("git status");
  });

  it("rejects patterns that are not plain token sequences", () => {
    for (const p of ["ls; rm", "a | b", "echo $HOME", "", "ls\nrm"]) {
      expect(parsePattern(p)).toBeNull();
    }
  });
});

describe("isTokenPrefix", () => {
  it("compares whole tokens", () => {
    expect(isTokenPrefix(["git", "status"], ["git", "status", "-s"])).toBe(true);
    expect(isTokenPrefix(["git", "status"], ["git", "status"])).toBe(true);
    expect(isTokenPrefix(["git", "status"], ["git", "statusx"])).toBe(false);
    expect(isTokenPrefix(["git", "status"], ["git"])).toBe(false);
    expect(isTokenPrefix([], ["git"])).toBe(false);
  });
});
