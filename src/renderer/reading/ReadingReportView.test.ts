/* @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ error: vi.fn(), info: vi.fn() }));
const log = vi.hoisted(() => ({ warn: vi.fn() }));
const saveReport = vi.hoisted(() => vi.fn());
const startReading = vi.hoisted(() => vi.fn());

import { ReadingReportView } from "@renderer/reading/ReadingReportView";

vi.mock("@tanstack/react-query", () => ({
  useQuery: (options: { queryKey: readonly string[] }) =>
    options.queryKey[0] === "reading-sessions"
      ? { isPending: false, isError: false, data: [session] }
      : {
          isPending: false,
          isError: false,
          data: { report: { status: "ready", content: "# Report" } },
        },
  useQueryClient: () => ({
    invalidateQueries: vi.fn(),
    removeQueries: vi.fn(),
    setQueryData: vi.fn(),
  }),
}));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, options?: { error?: string }) => {
      const translations: Record<string, string> = {
        "readingReport.rereadFailed": "Unable to restart reading. Please try again.",
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
  LocalizedStreamdown: ({ children }: { children: string }) => children,
}));
vi.mock("@renderer/components/ui/alert-dialog", () => ({
  AlertDialog: ({ children }: { children: React.ReactNode }) => children,
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
vi.mock("@renderer/components/ui/select", () => ({
  Select: ({ children }: { children: React.ReactNode }) => children,
  SelectContent: ({ children }: { children: React.ReactNode }) => children,
  SelectGroup: ({ children }: { children: React.ReactNode }) => children,
  SelectItem: ({ children }: { children: React.ReactNode }) => children,
  SelectLabel: ({ children }: { children: React.ReactNode }) => children,
  SelectTrigger: (props: React.ComponentProps<"button">) =>
    createElement("button", { "data-slot": "select-trigger", ...props }),
  SelectValue: () => null,
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
  startedAt: 0,
  completedAt: 0,
  activeSeconds: 0,
};

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  window.api = {
    readingSessions: {
      saveReport,
      start: startReading,
      generateReport: vi.fn(),
    },
  } as never;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("ReadingReportView", () => {
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

    const reread = [...host.querySelectorAll<HTMLButtonElement>("button")].at(-1)!;
    await act(async () => reread.click());

    expect(toast.error).toHaveBeenCalledWith("Unable to restart reading. Please try again.", {
      closeButton: true,
      duration: Infinity,
    });
    expect(JSON.stringify(toast.error.mock.calls)).not.toContain("implementation detail");
    expect(log.warn).toHaveBeenCalledWith("restart reading failed", error);
  });
});
