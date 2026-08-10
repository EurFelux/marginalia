/* @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));
const log = vi.hoisted(() => ({ warn: vi.fn() }));
const cancelReport = vi.hoisted(() => vi.fn());
const generateReport = vi.hoisted(() => vi.fn());
const invalidateQueries = vi.hoisted(() => vi.fn());
const saveReport = vi.hoisted(() => vi.fn());
const startReading = vi.hoisted(() => vi.fn());

import type { ReadingReportProgressStep } from "@shared/reading-sessions";
import { ReadingReportView } from "@renderer/reading/ReadingReportView";

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly string[] }) =>
    options.queryKey[0] === "reading-sessions"
      ? { isPending: false, isError: false, data: [session] }
      : {
          isPending: false,
          isError: false,
          data: { report: reportState },
        },
  useQueryClient: () => ({
    invalidateQueries,
    removeQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { error?: string }) => {
      const translations: Record<string, string> = {
        "readingReport.rereadFailed": "Unable to restart reading. Please try again.",
        "readingReport.cancelFailed": "Unable to stop generation. Please try again.",
        "readingReport.saveFailed": "Unable to save this report. Please try again.",
      };
      return `${translations[key] ?? key}${options?.error ?? ""}`;
    },
    i18n: { language: "en" },
  }),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@renderer/logger", () => ({ createLogger: () => log }));
vi.mock("@renderer/components/LocalizedStreamdown", () => ({
  LocalizedStreamdown: ({ children, className }: { children: string; className?: string }) =>
    createElement("div", { "data-testid": "report-body", className }, children),
}));
vi.mock("@renderer/components/ui/alert-dialog", () => ({
  AlertDialog: ({ open, children }: { open: boolean; children: React.ReactNode }) =>
    open ? children : null,
  AlertDialogContent: ({ children }: { children: React.ReactNode }) => children,
  AlertDialogDescription: ({ children }: { children: React.ReactNode }) => children,
  AlertDialogFooter: ({ children }: { children: React.ReactNode }) => children,
  AlertDialogTitle: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@renderer/components/ui/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => children,
  CardContent: ({ children }: { children: React.ReactNode }) => children,
  CardFooter: ({ children }: { children: React.ReactNode }) => children,
  CardHeader: ({ children }: { children: React.ReactNode }) => children,
  CardTitle: ({ children }: { children: React.ReactNode }) => children,
}));
vi.mock("@renderer/library/CoverImage", () => ({ CoverImage: () => null }));
vi.mock("@renderer/query/reading-session-queries", () => ({
  readingSessionQuery: (id: string) => ({ queryKey: ["reading-session", id] }),
  readingSessionsQuery: (id: string) => ({ queryKey: ["reading-sessions", id] }),
}));
vi.mock("@renderer/store/navigation-store", () => ({
  useNavigationStore: (selector: (state: Record<string, () => void>) => unknown) =>
    selector({ backToLibrary: vi.fn(), openBookReference: vi.fn(), openBook: vi.fn() }),
}));
vi.mock("@renderer/reading/ReportEditor", () => ({
  ReportEditor: ({ onSave }: { onSave: (content: string) => void }) =>
    createElement("button", { onClick: () => onSave("updated report") }, "save report"),
}));

const session = {
  id: "session-1",
  startedAt: Temporal.ZonedDateTime.from("2000-07-01T08:15:00+00:00[UTC]").epochMilliseconds,
  completedAt: Temporal.ZonedDateTime.from("2000-07-01T12:30:00+00:00[UTC]").epochMilliseconds,
  activeSeconds: 0,
};

let reportState:
  | { status: "empty" }
  | { status: "ready"; content: string }
  | {
      status: "regenerating";
      content: string;
      startedAt: number;
      progress: readonly ReadingReportProgressStep[];
    };

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  reportState = { status: "ready", content: "# Report" };
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  window.api = {
    readingSessions: {
      cancelReport,
      saveReport,
      start: startReading,
      generateReport,
    },
  } as never;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("ReadingReportView", () => {
  it("confirms before replacing an existing report", async () => {
    generateReport.mockResolvedValue({ outcome: "accepted" });
    await act(async () =>
      root.render(
        createElement(ReadingReportView, {
          book: {
            id: "book-1",
            title: null,
            author: null,
            hasCover: false,
            format: "epub",
            pageCount: null,
            hasTextLayer: false,
            readingState: "finished",
          },
        }),
      ),
    );

    const regenerate = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "readingReport.regenerate",
    )!;
    await act(async () => regenerate.click());

    expect(generateReport).not.toHaveBeenCalled();
    expect(host.textContent).toContain("readingReport.regenerateConfirmTitle");

    const confirm = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "readingReport.confirmRegenerate",
    )!;
    await act(async () => confirm.click());

    expect(generateReport).toHaveBeenCalledWith({ sessionId: "session-1" });
  });

  it("starts an initial generation without a replacement confirmation", async () => {
    reportState = { status: "empty" };
    generateReport.mockResolvedValue({ outcome: "accepted" });
    await act(async () =>
      root.render(
        createElement(ReadingReportView, {
          book: {
            id: "book-1",
            title: null,
            author: null,
            hasCover: false,
            format: "epub",
            pageCount: null,
            hasTextLayer: false,
            readingState: "finished",
          },
        }),
      ),
    );

    const generate = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "readingReport.generate",
    )!;
    await act(async () => generate.click());

    expect(generateReport).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(host.textContent).not.toContain("readingReport.regenerateConfirmTitle");
  });

  it("stops regeneration while keeping the old report visible", async () => {
    reportState = { status: "regenerating", content: "# Report", startedAt: 0, progress: [] };
    cancelReport.mockResolvedValue({ outcome: "canceled" });
    await act(async () =>
      root.render(
        createElement(ReadingReportView, {
          book: {
            id: "book-1",
            title: null,
            author: null,
            hasCover: false,
            format: "epub",
            pageCount: null,
            hasTextLayer: false,
            readingState: "finished",
          },
        }),
      ),
    );

    expect(host.querySelector("[data-testid='report-body']")?.textContent).toBe("# Report");
    const stop = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "readingReport.stopRegenerating",
    )!;
    expect(stop.className).toContain("text-destructive");
    expect(stop.className).toContain("bg-destructive/10");
    await act(async () => stop.click());

    expect(cancelReport).toHaveBeenCalledWith({ sessionId: "session-1" });
    expect(invalidateQueries).toHaveBeenCalledWith({
      queryKey: ["reading-session", "session-1"],
    });
    expect(toast.info).toHaveBeenCalledWith("readingReport.generationStopped");
  });

  it("keeps rejected cancellation details out of the localized failure toast", async () => {
    reportState = { status: "regenerating", content: "# Report", startedAt: 0, progress: [] };
    const error = new Error("provider secret from cancel path");
    cancelReport.mockRejectedValue(error);
    await act(async () =>
      root.render(
        createElement(ReadingReportView, {
          book: {
            id: "book-1",
            title: null,
            author: null,
            hasCover: false,
            format: "epub",
            pageCount: null,
            hasTextLayer: false,
            readingState: "finished",
          },
        }),
      ),
    );

    const stop = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "readingReport.stopRegenerating",
    )!;
    await act(async () => stop.click());

    expect(toast.error).toHaveBeenCalledWith("Unable to stop generation. Please try again.", {
      closeButton: true,
      duration: Infinity,
    });
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain("provider secret");
    expect(log.warn).toHaveBeenCalledWith("cancel reading report generation failed", error);
  });

  it("clamps a long book title to two lines without constraining the report body", () => {
    act(() =>
      root.render(
        createElement(ReadingReportView, {
          book: {
            id: "book-1",
            title:
              "A title deliberately long enough to overflow the report sidebar without truncation",
            author: null,
            hasCover: false,
            format: "epub",
            pageCount: null,
            hasTextLayer: false,
            readingState: "finished",
          },
        }),
      ),
    );

    const title = host.querySelector("h1")!;
    expect(title.className).toContain("line-clamp-2");
    expect(title.className).toContain("min-w-0");
    expect(host.querySelector("[data-testid='report-body']")?.className).not.toContain(
      "line-clamp",
    );
  });

  it("locks the session selector while editing to preserve the draft", () => {
    act(() =>
      root.render(
        createElement(ReadingReportView, {
          book: {
            id: "book-1",
            title: null,
            author: null,
            hasCover: false,
            format: "epub",
            pageCount: null,
            hasTextLayer: false,
            readingState: "finished",
          },
        }),
      ),
    );

    const edit = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "readingReport.edit",
    )!;
    act(() => edit.click());

    expect(host.querySelector<HTMLButtonElement>('[data-slot="select-trigger"]')?.disabled).toBe(
      true,
    );
  });

  it("labels the real session trigger and shows its localized date and time rather than its UUID", () => {
    act(() =>
      root.render(
        createElement(ReadingReportView, {
          book: {
            id: "book-1",
            title: null,
            author: null,
            hasCover: false,
            format: "epub",
            pageCount: null,
            hasTextLayer: false,
            readingState: "finished",
          },
        }),
      ),
    );

    const trigger = host.querySelector('[data-slot="select-trigger"]')!;
    expect(trigger.getAttribute("aria-label")).toBe("readingReport.session");
    expect(trigger.textContent).toContain("July 1, 2000");
    expect(trigger.textContent).toMatch(/\d{1,2}:\d{2}/);
    expect(trigger.textContent).not.toContain("session-1");
  });

  it("keeps rejected save details out of the localized failure toast", async () => {
    const error = new Error("SQLITE_CONSTRAINT: secret database path");
    saveReport.mockRejectedValue(error);
    await act(async () =>
      root.render(
        createElement(ReadingReportView, {
          book: {
            id: "book-1",
            title: null,
            author: null,
            hasCover: false,
            format: "epub",
            pageCount: null,
            hasTextLayer: false,
            readingState: "finished",
          },
        }),
      ),
    );

    const edit = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "readingReport.edit",
    )!;
    await act(async () => edit.click());
    const save = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "save report",
    )!;
    await act(async () => save.click());

    expect(toast.error).toHaveBeenCalledWith("Unable to save this report. Please try again.", {
      closeButton: true,
      duration: Infinity,
    });
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain("secret database path");
    expect(log.warn).toHaveBeenCalledWith("save reading report failed", error);
  });

  it("keeps rejected restart details out of the localized failure toast", async () => {
    const error = new Error("IPC readingSessions.start leaked implementation detail");
    startReading.mockRejectedValue(error);
    await act(async () =>
      root.render(
        createElement(ReadingReportView, {
          book: {
            id: "book-1",
            title: null,
            author: null,
            hasCover: false,
            format: "epub",
            pageCount: null,
            hasTextLayer: false,
            readingState: "finished",
          },
        }),
      ),
    );

    const reread = [...host.querySelectorAll<HTMLButtonElement>("button")].find(
      (button) => button.textContent === "readingReport.reread",
    )!;
    await act(async () => reread.click());
    const confirm = [...host.querySelectorAll<HTMLButtonElement>("button")]
      .filter((button) => button.textContent === "readingReport.reread")
      .at(-1)!;
    await act(async () => confirm.click());

    expect(toast.error).toHaveBeenCalledWith("Unable to restart reading. Please try again.", {
      closeButton: true,
      duration: Infinity,
    });
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain("implementation detail");
    expect(log.warn).toHaveBeenCalledWith("restart reading failed", error);
  });
});
