import type { ChatUIMessage } from "@renderer/ai/types";

/**
 * 消息时刻（epoch ms）。历史消息由 MessageDto.createdAt 水合而来；
 * live 消息（本轮发送/流式产出）尚未回读落库时间，回退到调用方给的当前时刻。
 */
export function messageCreatedAt(m: ChatUIMessage, fallbackMs: number): number {
  return m.metadata?.createdAt ?? fallbackMs;
}

function localDate(ms: number, timeZone: string): Temporal.PlainDate {
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone).toPlainDate();
}

/** 本条与上一条跨自然日（prevMs 为 null ⇒ 列表首条）⇒ 该插一行日期分隔。 */
export function startsNewDay(prevMs: number | null, ms: number, timeZone: string): boolean {
  if (prevMs === null) return true;
  return !localDate(prevMs, timeZone).equals(localDate(ms, timeZone));
}

/** 日期分隔行的措辞类别：今天 / 昨天 / 更早（更早用绝对日期）。 */
export type DayKind = "today" | "yesterday" | "older";

export function dayKind(ms: number, nowMs: number, timeZone: string): DayKind {
  const day = localDate(ms, timeZone);
  const today = localDate(nowMs, timeZone);
  if (day.equals(today)) return "today";
  if (day.equals(today.subtract({ days: 1 }))) return "yesterday";
  return "older";
}

/** `<time dateTime>` 用的机器可读时刻（本地时区的 ISO 串）。 */
export function isoAt(ms: number, timeZone: string): string {
  return Temporal.Instant.fromEpochMilliseconds(ms).toZonedDateTimeISO(timeZone).toString({
    timeZoneName: "never",
  });
}
