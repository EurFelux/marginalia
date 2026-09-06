import { describe, expect, it } from "vitest";
import { dayKind, isoAt, messageCreatedAt, startsNewDay } from "@renderer/ai/message-time";
import type { ChatUIMessage } from "@renderer/ai/types";

const TZ = "Asia/Shanghai";
const at = (iso: string) => Temporal.ZonedDateTime.from(`${iso}[${TZ}]`).epochMilliseconds;
const message = (metadata?: ChatUIMessage["metadata"]): ChatUIMessage => ({
  id: "m1",
  role: "user",
  parts: [{ type: "text", text: "hi" }],
  metadata,
});

describe("messageCreatedAt", () => {
  it("uses the persisted timestamp when present", () => {
    expect(messageCreatedAt(message({ createdAt: 42 }), 99)).toBe(42);
  });
  it("falls back for a live message that carries no timestamp", () => {
    expect(messageCreatedAt(message(), 99)).toBe(99);
    expect(messageCreatedAt(message({ contextChips: [] }), 99)).toBe(99);
  });
});

describe("startsNewDay", () => {
  it("first message always starts a day", () => {
    expect(startsNewDay(null, at("2026-09-06T10:00:00+08:00"), TZ)).toBe(true);
  });
  it("same local day → no divider", () => {
    expect(startsNewDay(at("2026-09-06T00:01:00+08:00"), at("2026-09-06T23:59:00+08:00"), TZ)).toBe(
      false,
    );
  });
  it("crossing local midnight → divider", () => {
    expect(startsNewDay(at("2026-09-06T23:59:00+08:00"), at("2026-09-07T00:01:00+08:00"), TZ)).toBe(
      true,
    );
  });
});

describe("dayKind", () => {
  const now = at("2026-09-06T09:00:00+08:00");
  it("today", () => {
    expect(dayKind(at("2026-09-06T01:00:00+08:00"), now, TZ)).toBe("today");
  });
  it("yesterday", () => {
    expect(dayKind(at("2026-09-05T23:00:00+08:00"), now, TZ)).toBe("yesterday");
  });
  it("older", () => {
    expect(dayKind(at("2026-09-04T23:00:00+08:00"), now, TZ)).toBe("older");
  });
  it("classifies by the given zone, not the host zone", () => {
    // 同一时刻在 UTC 尚是 9-05，在 +08:00 已是 9-06。
    const instant = at("2026-09-06T02:00:00+08:00");
    expect(dayKind(instant, now, TZ)).toBe("today");
    expect(dayKind(instant, now, "UTC")).toBe("yesterday");
  });
});

describe("isoAt", () => {
  it("renders the local wall clock without a zone suffix", () => {
    expect(isoAt(at("2026-09-06T14:32:00+08:00"), TZ)).toBe("2026-09-06T14:32:00+08:00");
  });
});
