/* @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const log = vi.hoisted(() => ({ warn: vi.fn() }));
const readingState = vi.hoisted(() => vi.fn());

vi.mock("@renderer/logger", () => ({ createLogger: () => log }));

import { useReadingClock } from "@renderer/reader/use-reading-clock";

function Clock({ bookId }: { bookId: string | null }) {
  useReadingClock(bookId);
  return null;
}

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  vi.clearAllMocks();
  readingState.mockResolvedValue(undefined);
  window.api = { stats: { readingState } } as never;
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("useReadingClock", () => {
  it("warns with the cleanup error when its idle report rejects on unmount", async () => {
    await act(async () => root.render(createElement(Clock, { bookId: "book-1" })));
    expect(readingState).toHaveBeenCalledWith({ status: "active", bookId: "book-1" });

    const error = new Error("IPC unavailable");
    readingState.mockRejectedValueOnce(error);
    await act(async () => root.unmount());

    expect(readingState).toHaveBeenLastCalledWith({ status: "idle" });
    expect(log.warn).toHaveBeenCalledWith("reading-state cleanup failed", error);
  });
});
