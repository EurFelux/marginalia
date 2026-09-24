import { beforeEach, describe, expect, it } from "vitest";
import { SEARCH_INITIAL, useSearchStore } from "@renderer/store/search-store";
import type { BookSearchHit, BookSearchResult } from "@shared/search";

const hit = (occurrence: number): BookSearchHit => ({
  chapterId: "ch",
  chapterTitle: "Chapter",
  snippet: { before: "", match: "x", after: "" },
  target: { format: "epub", href: "s1.xhtml", occurrence },
});
const ok = (n: number): BookSearchResult => ({
  kind: "ok",
  hits: Array.from({ length: n }, (_, i) => hit(i)),
  truncated: false,
});

beforeEach(() => useSearchStore.setState(SEARCH_INITIAL));

describe("search-store", () => {
  it("requesting focus bumps the focus signal", () => {
    useSearchStore.getState().requestFocus();
    useSearchStore.getState().requestFocus();
    expect(useSearchStore.getState().focusNonce).toBe(2);
  });

  it("a new result clears the active hit", () => {
    const store = useSearchStore.getState();
    store.setResult("b1", "x", ok(3));
    store.activate(1);
    store.setResult("b1", "xy", ok(2));
    expect(useSearchStore.getState().activeIndex).toBeNull();
  });

  it("re-publishing the same result keeps the active hit (the panel remounts on tab switches)", () => {
    const store = useSearchStore.getState();
    const result = ok(3);
    store.setResult("b1", "x", result);
    store.activate(2);
    store.setResult("b1", "x", result);
    expect(useSearchStore.getState().activeIndex).toBe(2);
  });

  it("activating a hit issues a jump command with a fresh nonce", () => {
    const store = useSearchStore.getState();
    store.setResult("b1", "x", ok(3));
    store.activate(2);
    store.activate(2);
    const { jump, activeIndex } = useSearchStore.getState();
    expect(activeIndex).toBe(2);
    expect(jump).toMatchObject({ hit: hit(2), query: "x", nonce: 2 });
  });

  it("steps through hits and wraps around at both ends", () => {
    const store = useSearchStore.getState();
    store.setResult("b1", "x", ok(3));
    store.step(1);
    expect(useSearchStore.getState().activeIndex).toBe(0);
    store.step(-1);
    expect(useSearchStore.getState().activeIndex).toBe(2);
    store.step(1);
    expect(useSearchStore.getState().activeIndex).toBe(0);
  });

  it("stepping backwards with nothing active starts from the last hit", () => {
    const store = useSearchStore.getState();
    store.setResult("b1", "x", ok(3));
    store.step(-1);
    expect(useSearchStore.getState().activeIndex).toBe(2);
  });

  it("stepping without hits does nothing", () => {
    const store = useSearchStore.getState();
    store.setResult("b1", "x", ok(0));
    store.step(1);
    expect(useSearchStore.getState().jump).toBeNull();
  });

  it("switching books drops the query and results", () => {
    const store = useSearchStore.getState();
    store.setQuery("x");
    store.setResult("b1", "x", ok(1));
    store.resetForBook("b2");
    const s = useSearchStore.getState();
    expect(s).toMatchObject({ bookId: "b2", query: "", result: null, activeIndex: null });
  });
});
