import { describe, expect, it } from "vitest";
import en from "@shared/i18n/locales/en";
import zhCN from "@shared/i18n/locales/zh-CN";

const readingCompletionKeys = [
  "reader.completeReading.action",
  "reader.completeReading.completed",
  "reader.completeReading.confirmTitle",
  "reading.openReference",
  "reading.referenceMode",
  "reading.routeLoadError",
  "reading.routeLoading",
  "reading.routeNotFound",
  "reading.routeSelectBook",
  "readingStart.action",
  "readingStart.description",
  "readingStart.title",
] as const;

const task6ReadingKeys = [
  "readingReport.cancelFailed",
  "readingReport.confirmRegenerate",
  "readingReport.edit",
  "readingReport.empty",
  "readingReport.generate",
  "readingReport.generateFailed",
  "readingReport.generationStopped",
  "readingReport.insufficientEvidence",
  "readingReport.keepCurrent",
  "readingReport.loadFailed",
  "readingReport.reference",
  "readingReport.regenerate",
  "readingReport.regenerateConfirmDescription",
  "readingReport.regenerateConfirmTitle",
  "readingReport.reread",
  "readingReport.rereadConfirmDescription",
  "readingReport.rereadConfirmTitle",
  "readingReport.rereadFailed",
  "readingReport.retry",
  "readingReport.saveFailed",
  "readingReport.session",
  "readingReport.sessionHistory",
  "readingReport.stopGenerating",
  "readingReport.stopRegenerating",
  "readingReport.title",
  "readingSession.activeTime",
  "readingSession.completedAt",
  "readingSession.elapsedDays",
  "readingSession.startedAt",
  "time.hourShort",
  "time.minuteShort",
] as const;

const englishTask6PluralKeys = ["readingSession.days_one", "readingSession.days_other"] as const;

const chineseTask6PluralKeys = ["readingSession.days"] as const;

const reportProgressKeys = [
  "readingReport.progress.elapsed",
  "readingReport.progress.skipped",
  "readingReport.progress.title",
  "readingReport.progress.tool.getBookSummary",
  "readingReport.progress.tool.getChapterSummary",
  "readingReport.progress.tool.getPreviousReadingReport",
  "readingReport.progress.tool.getSessionReadingStats",
  "readingReport.progress.tool.getToc",
  "readingReport.progress.tool.investigateConversation",
  "readingReport.progress.tool.listAnnotations",
  "readingReport.progress.tool.listBookNotes",
  "readingReport.progress.tool.listConversations",
  "readingReport.progress.tool.listPreviousReadingSessions",
  "readingReport.progress.tool.readChapterText",
  "readingReport.progress.tool.readConversation",
  "readingReport.progress.tool.readMemory",
  "readingReport.progress.tool.readPage",
  "readingReport.progress.tool.saveMemory",
  "readingReport.progress.tool.unknown",
  "readingReport.progress.tool.updateMemory",
] as const;

const englishReportProgressPluralKeys = [
  "readingReport.progress.count_one",
  "readingReport.progress.count_other",
  "readingReport.progress.steps_one",
  "readingReport.progress.steps_other",
] as const;

const chineseReportProgressPluralKeys = [
  "readingReport.progress.count",
  "readingReport.progress.steps",
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

  it("provides non-empty copy for the reading completion flow", () => {
    for (const key of readingCompletionKeys) {
      expectNonEmptyString(en, key);
      expectNonEmptyString(zhCN, key);
    }
  });

  it("provides non-empty copy for Task 6 reading report flow", () => {
    for (const key of task6ReadingKeys) {
      expectNonEmptyString(en, key);
      expectNonEmptyString(zhCN, key);
    }
    for (const key of englishTask6PluralKeys) expectNonEmptyString(en, key);
    for (const key of chineseTask6PluralKeys) expectNonEmptyString(zhCN, key);
  });

  it("provides non-empty copy for the report generation timeline", () => {
    for (const key of reportProgressKeys) {
      expectNonEmptyString(en, key);
      expectNonEmptyString(zhCN, key);
    }
    for (const key of englishReportProgressPluralKeys) expectNonEmptyString(en, key);
    for (const key of chineseReportProgressPluralKeys) expectNonEmptyString(zhCN, key);
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
