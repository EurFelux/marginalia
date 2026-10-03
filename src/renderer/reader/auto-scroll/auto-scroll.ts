/**
 * 自动滚动的纯几何 / 档位逻辑（无 DOM 副作用），供 auto-scroll-controller 逐帧调用。
 * 速度与滚动位置全程整数运算，不用浮点（spec §3.2）。
 * Spec: docs/specs/2026-10-03-reader-auto-scroll-design.md
 */

/** 速度档位：整数 1–20，10 = 1.0×。显示为倍率（0.1×–2.0×），落盘与运算都用档位。 */
export const MIN_SPEED_LEVEL = 1;
export const MAX_SPEED_LEVEL = 20;

/** 每档 1 px/s：1.0× = 10 px/s，落在默认排版下中文与英文常速阅读之间（spec §3.2）。 */
const PX_PER_SEC_PER_LEVEL = 1;

/** 单帧时长上限（ms）：窗口隐藏后 rAF 恢复的首帧间隔可达数秒，不夹住会一步跳出一大段。 */
export const MAX_FRAME_MS = 100;

/** 书末判定容差（px）：浏览器回读的 scrollTop 可能带小数，与 scrollHeight − clientHeight 差零点几像素。 */
const END_TOLERANCE_PX = 1;

/** carry 的单位：像素·毫秒。攒满 1000（= 1px·s）进 1px。 */
const PX_MS_PER_PX = 1000;

/** 已滚到底（含内容不足一屏）。 */
export function isAtScrollEnd({
  scrollTop,
  scrollHeight,
  clientHeight,
}: {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
}): boolean {
  return scrollHeight - scrollTop - clientHeight <= END_TOLERANCE_PX;
}

/** 自管的滚动游标：整数像素位置 + 不足 1px 的整数余量（像素·毫秒）。 */
export interface ScrollCursor {
  position: number;
  carry: number;
}

/**
 * 推进一帧，返回应写入 scrollTop 的整数位置与新余量。
 *
 * 逐帧位移常不足 1px（10 px/s × 16ms = 0.16px）：只写整数像素，余量结转到下一帧。不基于回读值累加——
 * 回读可能被取整或吸附到物理像素，会把小数位移整段丢掉、低速时原地不动。回读值与 position 偏差 ≥1px
 * 视为外部改动（虚拟列表测高修正、PDF 缩放复位、浏览器在书末夹住），以取整后的回读值为新基准、余量
 * 清零；不足 1px 的偏差是吸附，忽略。cursor 为 null = 首帧，取回读值。
 *
 * pxPerSec、dtMs 须为整数（档位换算与取整后的时间戳保证）。
 */
export function advanceCursor(
  cursor: ScrollCursor | null,
  actual: number,
  pxPerSec: number,
  dtMs: number,
): ScrollCursor {
  const base =
    cursor == null || Math.abs(actual - cursor.position) >= 1
      ? { position: Math.round(actual), carry: 0 }
      : cursor;
  const total = base.carry + pxPerSec * Math.min(dtMs, MAX_FRAME_MS);
  const carry = total % PX_MS_PER_PX;
  return { position: base.position + (total - carry) / PX_MS_PER_PX, carry };
}

/** 夹到 [1, 20]（落盘值越界时归位）。 */
export function clampSpeedLevel(level: number): number {
  return Math.min(MAX_SPEED_LEVEL, Math.max(MIN_SPEED_LEVEL, Math.round(level)));
}

/** 按方向挪一档，两端夹住。 */
export function stepSpeedLevel(level: number, dir: 1 | -1): number {
  return clampSpeedLevel(clampSpeedLevel(level) + dir);
}

/** 控制条显示：整数商与余数拼出倍率（10 → 「1.0×」），不经浮点除法。 */
export function formatSpeedLevel(level: number): string {
  const l = clampSpeedLevel(level);
  const tenths = l % 10;
  return `${(l - tenths) / 10}.${tenths}×`;
}

/** 档位 → 逐帧计算用的像素速度（整数 px/s）。 */
export function speedPxPerSec(level: number): number {
  return clampSpeedLevel(level) * PX_PER_SEC_PER_LEVEL;
}
