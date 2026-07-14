/* @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const toast = vi.hoisted(() => ({ error: vi.fn() }));
const invalidateQueries = vi.hoisted(() => vi.fn(async () => undefined));
const start = vi.hoisted(() => vi.fn());
const completeAction = vi.hoisted(() => vi.fn());

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock("@tanstack/react-query", () => ({
  useQueryClient: () => ({ invalidateQueries }),
}));
vi.mock("sonner", () => ({ toast }));
vi.mock("@renderer/library/CoverImage", () => ({ CoverImage: () => null }));
vi.mock("@renderer/components/ui/dialog", () => ({
  Dialog: ({ children }: { children: React.ReactNode }) => children,
  DialogContent: ({ children }: { children: React.ReactNode }) => children,
  DialogFooter: ({ children }: { children: React.ReactNode }) => children,
  DialogHeader: ({ children }: { children: React.ReactNode }) => children,
  DialogTitle: ({ children }: { children: React.ReactNode }) => children,
}));

import { CompleteReadingDialog } from "@renderer/reading/CompleteReadingDialog";
import { ReadingStartView } from "@renderer/reading/ReadingStartView";

function deferred() {
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<never>((_resolve, rej) => {
    reject = rej;
  });
  return { promise, reject };
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  window.api = {
    readingSessions: {
      start,
      complete: completeAction,
    },
  } as never;
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("reading session actions", () => {
  it("disables start while pending and shows a persistent localized failure toast", async () => {
    const task = deferred();
    start.mockReturnValue(task.promise);
    await act(async () =>
      root.render(
        createElement(ReadingStartView, {
          book: {
            id: "book",
            title: null,
            author: null,
            hasCover: false,
            format: "epub",
            pageCount: null,
            hasTextLayer: false,
            readingState: "not-started",
          },
        }),
      ),
    );

    const button = host.querySelector<HTMLButtonElement>("button")!;
    await act(async () => button.click());
    expect(button.disabled).toBe(true);
    expect(start).toHaveBeenCalledOnce();

    await act(async () => task.reject(new Error("internal detail")));
    expect(toast.error).toHaveBeenCalledWith("readingStart.failed", {
      closeButton: true,
      duration: Infinity,
    });
  });

  it("disables completion while pending and leaves the dialog open after a localized failure", async () => {
    const task = deferred();
    completeAction.mockReturnValue(task.promise);
    await act(async () => root.render(createElement(CompleteReadingDialog, { bookId: "book" })));

    const complete = [...host.querySelectorAll<HTMLButtonElement>("button")].at(-1)!;
    await act(async () => complete.click());
    expect(complete.disabled).toBe(true);
    expect(completeAction).toHaveBeenCalledOnce();

    await act(async () => task.reject(new Error("internal detail")));
    expect(toast.error).toHaveBeenCalledWith("reader.completeReading.failed", {
      closeButton: true,
      duration: Infinity,
    });
  });
});
