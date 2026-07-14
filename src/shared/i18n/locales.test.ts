import { describe, expect, it } from "vitest";
import en from "@shared/i18n/locales/en";
import zhCN from "@shared/i18n/locales/zh-CN";

const task5ReadingKeys = [
  "reading.complete",
  "reading.completeConfirm",
  "reading.openReference",
  "reading.referenceMode",
  "reading.routeLoadError",
  "reading.routeLoading",
  "reading.routeNotFound",
  "reading.routeSelectBook",
  "reading.start",
] as const;

const restoreKindKeys = ["settings.backup.kindCompact", "settings.backup.kindFull"] as const;

const englishRestoreConfirmationKeys = [
  "settings.backup.confirmCompactRestore_one",
  "settings.backup.confirmCompactRestore_other",
  "settings.backup.confirmFullRestore_one",
  "settings.backup.confirmFullRestore_other",
] as const;

const chineseRestoreConfirmationKeys = [
  "settings.backup.confirmCompactRestore",
  "settings.backup.confirmFullRestore",
] as const;

describe("locale completeness", () => {
  function expectNonEmptyString(locale: Record<string, unknown>, key: string) {
    const value = locale[key];
    expect(typeof value).toBe("string");
    if (typeof value !== "string") return;
    expect(value.trim()).not.toBe("");
  }

  it("provides non-empty English copy for Task 5 reading flow", () => {
    for (const key of task5ReadingKeys) expectNonEmptyString(en, key);
  });

  it("keeps restore confirmation keys used by both locales", () => {
    for (const key of restoreKindKeys) {
      expectNonEmptyString(en, key);
      expectNonEmptyString(zhCN, key);
    }
    for (const key of englishRestoreConfirmationKeys) expectNonEmptyString(en, key);
    for (const key of chineseRestoreConfirmationKeys) expectNonEmptyString(zhCN, key);
  });
});
