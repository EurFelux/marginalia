import { describe, it, expect, vi } from "vitest";
import { SearchService } from "@main/ai/search/search-service";
import type { SearchBackend, SearchHit } from "@main/ai/search/types";

function backend(id: string, impl: () => Promise<SearchHit[]>) {
  const search = impl;
  const close = vi.fn().mockResolvedValue(undefined);
  const b: SearchBackend = { id, search, close };
  return { b, search, close };
}
const hit: SearchHit = { title: "t", url: "https://x", snippet: "s" };

describe("SearchService", () => {
  it("returns the first backend's results when it succeeds", async () => {
    const { b: b1 } = backend("a", vi.fn().mockResolvedValue([hit]));
    const { b: b2, search: search2 } = backend("b", vi.fn().mockResolvedValue([]));
    await expect(new SearchService([b1, b2]).search("q", {})).resolves.toEqual([hit]);
    expect(search2).not.toHaveBeenCalled();
  });
  it("falls back to the next backend when the first throws", async () => {
    const { b: b1 } = backend("a", vi.fn().mockRejectedValue(new Error("429")));
    const { b: b2, search: search2 } = backend("b", vi.fn().mockResolvedValue([hit]));
    await expect(new SearchService([b1, b2]).search("q", {})).resolves.toEqual([hit]);
    expect(search2).toHaveBeenCalled();
  });
  it("throws when all backends fail", async () => {
    const { b: b1 } = backend("a", vi.fn().mockRejectedValue(new Error("x")));
    const { b: b2 } = backend("b", vi.fn().mockRejectedValue(new Error("y")));
    await expect(new SearchService([b1, b2]).search("q", {})).rejects.toThrow(
      /all web search backends failed/,
    );
  });
  it("closes every backend", async () => {
    const { b: b1, close: close1 } = backend("a", vi.fn());
    const { b: b2, close: close2 } = backend("b", vi.fn());
    await new SearchService([b1, b2]).close();
    expect(close1).toHaveBeenCalled();
    expect(close2).toHaveBeenCalled();
  });
});

describe("SearchService error message", () => {
  it("includes the last backend's error message", async () => {
    const { b: b1 } = backend("a", vi.fn().mockRejectedValue(new Error("x")));
    const { b: b2 } = backend("b", vi.fn().mockRejectedValue(new Error("HTTP 429: too fast")));
    await expect(new SearchService([b1, b2]).search("q", {})).rejects.toThrow(
      "all web search backends failed: HTTP 429: too fast",
    );
  });
});

describe("SearchService.fetchPage", () => {
  const page = { title: "T", content: "C" };

  it("skips backends without fetchPage and falls back in order", async () => {
    const plain = backend("plain", vi.fn()).b;
    const failing: SearchBackend = {
      ...backend("f1", vi.fn()).b,
      fetchPage: vi.fn().mockRejectedValue(new Error("404")),
    };
    const fetchPage = vi.fn().mockResolvedValue(page);
    const working: SearchBackend = { ...backend("f2", vi.fn()).b, fetchPage };
    await expect(
      new SearchService([plain, failing, working]).fetchPage("https://x", {}),
    ).resolves.toEqual(page);
    expect(fetchPage).toHaveBeenCalledWith("https://x", {});
  });
  it("rejects when no backend can fetch pages", async () => {
    await expect(
      new SearchService([backend("plain", vi.fn()).b]).fetchPage("https://x", {}),
    ).rejects.toThrow(/can fetch pages/);
  });
  it("aggregates the failure reason when every fetcher fails", async () => {
    const failing: SearchBackend = {
      ...backend("f1", vi.fn()).b,
      fetchPage: vi.fn().mockRejectedValue(new Error("HTTP 403: blocked")),
    };
    await expect(new SearchService([failing]).fetchPage("https://x", {})).rejects.toThrow(
      "all web search backends failed: HTTP 403: blocked",
    );
  });
});
