import { describe, expect, it } from "vitest";
import { notificationMessage } from "@renderer/notifications/app-notifications";

// 假 t：回显 fallback 文案 + 插值，足够断言「有内容/无内容」。
const t = ((_key: string, fallback: string, vars?: Record<string, unknown>) =>
  vars
    ? fallback.replace(/\{\{(\w+)\}\}/g, (_m, k) => String(vars[k]))
    : fallback) as unknown as Parameters<typeof notificationMessage>[1];

describe("notificationMessage", () => {
  it("formats a memoryConsolidated notification with counts", () => {
    const msg = notificationMessage(
      { kind: "memoryConsolidated", saved: 2, updated: 1, deleted: 0 },
      t,
    );
    expect(msg).not.toBeNull();
    expect(msg).toContain("2");
    expect(msg).toContain("1");
  });

  it("returns null when nothing changed", () => {
    const msg = notificationMessage(
      { kind: "memoryConsolidated", saved: 0, updated: 0, deleted: 0 },
      t,
    );
    expect(msg).toBeNull();
  });
});
