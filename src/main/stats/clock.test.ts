import { describe, expect, it } from "vitest";
import { createReadingClock } from "@main/stats/clock";

function setup(start = 0) {
  let now = start;
  const commits: { bookId: string; atMs: number; seconds: number }[] = [];
  const clock = createReadingClock({
    now: () => now,
    commit: (bookId, atMs, seconds) => commits.push({ bookId, atMs, seconds }),
  });
  return { clock, commits, advance: (ms: number) => (now += ms), setNow: (v: number) => (now = v) };
}

describe("createReadingClock", () => {
  it("does not commit while inactive (no book / blurred / asleep)", () => {
    const { clock, commits, advance } = setup();
    clock.setFocused(true);
    clock.setAwake(true);
    advance(60_000); // 无 book → 不活跃
    clock.tick();
    expect(commits).toEqual([]);
  });

  it("accumulates seconds for the active book on tick", () => {
    const { clock, commits, advance } = setup();
    clock.setFocused(true);
    clock.setAwake(true);
    clock.setReadingBook("b1"); // 此刻起活跃
    advance(90_000);
    clock.tick();
    expect(commits).toEqual([{ bookId: "b1", atMs: 90_000, seconds: 90 }]);
  });

  it("settles elapsed time on blur (active -> inactive)", () => {
    const { clock, commits, advance } = setup();
    clock.setAwake(true);
    clock.setFocused(true);
    clock.setReadingBook("b1");
    advance(30_000);
    clock.setFocused(false); // 结算
    expect(commits).toEqual([{ bookId: "b1", atMs: 30_000, seconds: 30 }]);
    advance(60_000); // 失焦期间不计
    clock.tick();
    expect(commits).toHaveLength(1);
  });

  it("settles old book before switching books", () => {
    const { clock, commits, advance } = setup();
    clock.setAwake(true);
    clock.setFocused(true);
    clock.setReadingBook("b1");
    advance(20_000);
    clock.setReadingBook("b2"); // 先结算 b1 再切
    advance(10_000);
    clock.tick();
    expect(commits).toEqual([
      { bookId: "b1", atMs: 20_000, seconds: 20 },
      { bookId: "b2", atMs: 30_000, seconds: 10 },
    ]);
  });

  it("carries sub-second remainder across ticks (no drift)", () => {
    const { clock, commits, advance } = setup();
    clock.setAwake(true);
    clock.setFocused(true);
    clock.setReadingBook("b1");
    advance(1_500);
    clock.tick(); // 提交 1s，余 500ms 进位
    advance(1_500);
    clock.tick(); // 累计 2000ms → 提交 2s
    expect(commits).toEqual([
      { bookId: "b1", atMs: 1_500, seconds: 1 },
      { bookId: "b1", atMs: 3_000, seconds: 2 },
    ]);
  });

  it("does not commit zero-second ticks", () => {
    const { clock, commits, advance } = setup();
    clock.setAwake(true);
    clock.setFocused(true);
    clock.setReadingBook("b1");
    advance(500);
    clock.tick();
    expect(commits).toEqual([]);
  });

  it("setReadingBook(null) settles and stops", () => {
    const { clock, commits, advance } = setup();
    clock.setAwake(true);
    clock.setFocused(true);
    clock.setReadingBook("b1");
    advance(45_000);
    clock.setReadingBook(null);
    expect(commits).toEqual([{ bookId: "b1", atMs: 45_000, seconds: 45 }]);
    advance(60_000);
    clock.tick();
    expect(commits).toHaveLength(1);
  });
});
