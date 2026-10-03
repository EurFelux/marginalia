import { describe, expect, it } from "vitest";
import {
  MAX_FRAME_MS,
  MAX_SPEED_LEVEL,
  MIN_SPEED_LEVEL,
  advanceCursor,
  clampSpeedLevel,
  formatSpeedLevel,
  isAtScrollEnd,
  speedPxPerSec,
  stepSpeedLevel,
  type ScrollCursor,
} from "./auto-scroll";

describe("isAtScrollEnd", () => {
  it("is true at the bottom, within a sub-pixel tolerance", () => {
    expect(isAtScrollEnd({ scrollTop: 600, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
    expect(isAtScrollEnd({ scrollTop: 599.5, scrollHeight: 1000, clientHeight: 400 })).toBe(true);
  });

  it("is false while there is still content below", () => {
    expect(isAtScrollEnd({ scrollTop: 590, scrollHeight: 1000, clientHeight: 400 })).toBe(false);
  });

  it("treats content shorter than the viewport as already at the end", () => {
    expect(isAtScrollEnd({ scrollTop: 0, scrollHeight: 300, clientHeight: 400 })).toBe(true);
  });
});

describe("advanceCursor", () => {
  it("starts from the actual position on the first frame", () => {
    expect(advanceCursor(null, 120, 10, 100)).toEqual({ position: 121, carry: 0 });
  });

  it("carries sub-pixel steps so slow speeds still move at an exact rate", () => {
    // 10 px/s × 16ms = 160 像素·毫秒/帧：不结转余量的话每帧都不足 1px、永远原地不动。
    let cursor: ScrollCursor | null = null;
    for (let i = 0; i < 1 + 125; i++)
      cursor = advanceCursor(cursor, cursor?.position ?? 100, 10, i === 0 ? 0 : 16);
    // 125 × 16ms = 2000ms → 恰好 20px，无余量。
    expect(cursor).toEqual({ position: 120, carry: 0 });
  });

  it("only ever produces whole pixels and integer carries", () => {
    let cursor: ScrollCursor | null = null;
    for (let i = 0; i < 500; i++) {
      cursor = advanceCursor(cursor, cursor?.position ?? 0, 7, 17);
      expect(Number.isInteger(cursor.position)).toBe(true);
      expect(Number.isInteger(cursor.carry)).toBe(true);
    }
  });

  it("ignores sub-pixel snapping of the read-back value", () => {
    // 写入 101，浏览器吸附到物理像素后回读 100.5：不算外部改动，余量照常结转。
    expect(advanceCursor({ position: 101, carry: 900 }, 100.5, 10, 16)).toEqual({
      position: 102,
      carry: 60,
    });
  });

  it("rebases on the rounded actual position after an external change", () => {
    // 测高修正把视口推到 500.4：偏差 ≥1px → 以取整回读值为基准，余量清零。
    expect(advanceCursor({ position: 100, carry: 900 }, 500.4, 10, 100)).toEqual({
      position: 501,
      carry: 0,
    });
  });

  it("caps the frame duration so a long pause does not jump", () => {
    // 10 px/s × 夹到的 100ms = 1px。
    expect(advanceCursor(null, 0, 10, 5000)).toEqual({
      position: (10 * MAX_FRAME_MS) / 1000,
      carry: 0,
    });
  });
});

describe("speed levels", () => {
  it("clamps stored values into [1, 20]", () => {
    expect(clampSpeedLevel(10)).toBe(10);
    expect(clampSpeedLevel(0)).toBe(MIN_SPEED_LEVEL);
    expect(clampSpeedLevel(99)).toBe(MAX_SPEED_LEVEL);
  });

  it("moves one level and clamps at both ends", () => {
    expect(stepSpeedLevel(10, 1)).toBe(11);
    expect(stepSpeedLevel(10, -1)).toBe(9);
    expect(stepSpeedLevel(MIN_SPEED_LEVEL, -1)).toBe(MIN_SPEED_LEVEL);
    expect(stepSpeedLevel(MAX_SPEED_LEVEL, 1)).toBe(MAX_SPEED_LEVEL);
    expect(stepSpeedLevel(99, -1)).toBe(MAX_SPEED_LEVEL - 1);
  });

  it("formats the level as a multiplier with one decimal", () => {
    expect(formatSpeedLevel(10)).toBe("1.0×");
    expect(formatSpeedLevel(1)).toBe("0.1×");
    expect(formatSpeedLevel(3)).toBe("0.3×");
    expect(formatSpeedLevel(15)).toBe("1.5×");
    expect(formatSpeedLevel(20)).toBe("2.0×");
  });

  it("maps each level to 1 px/s", () => {
    expect(speedPxPerSec(10)).toBe(10);
    expect(speedPxPerSec(1)).toBe(1);
    expect(speedPxPerSec(99)).toBe(MAX_SPEED_LEVEL);
  });
});
