/* @vitest-environment happy-dom */
import { act, createElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BookRoute } from "@renderer/reading/BookRoute";

let queryResult: { isPending: boolean; isError: boolean; data?: { readingState: "reading" } };

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => queryResult,
}));
vi.mock("@renderer/store/navigation-store", () => ({
  useNavigationStore: (selector: (state: { currentBookId: string; bookMode: "auto" }) => unknown) =>
    selector({ currentBookId: "book-1", bookMode: "auto" }),
}));
vi.mock("@renderer/reader/ReaderView", () => ({ ReaderView: () => null }));
vi.mock("@renderer/reading/ReadingStartView", () => ({ ReadingStartView: () => null }));
vi.mock("@renderer/reading/ReadingReportView", () => ({ ReadingReportView: () => null }));
vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => `translated:${key}` }),
}));

let host: HTMLDivElement;
let root: Root;

beforeEach(() => {
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
});

afterEach(() => {
  act(() => root.unmount());
  host.remove();
});

describe("BookRoute", () => {
  it.each([
    [{ isPending: true, isError: false }, "reading.routeLoading"],
    [{ isPending: false, isError: true }, "reading.routeLoadError"],
    [{ isPending: false, isError: false }, "reading.routeNotFound"],
  ] as const)("uses i18n copy for route status %#", (result, key) => {
    queryResult = result;
    act(() => root.render(createElement(BookRoute)));
    expect(host.textContent).toBe(`translated:${key}`);
  });
});
