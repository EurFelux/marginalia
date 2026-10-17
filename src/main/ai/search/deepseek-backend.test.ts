import { describe, it, expect, vi } from "vitest";
import {
  DEEPSEEK_SEARCH_QUERY_MAX,
  makeDeepseekBackend,
  mapDeepseekResults,
} from "@main/ai/search/deepseek-backend";

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

// apiKey 用 null 表示「未配置」：传 undefined 会被默认参数吞掉
function backendWith(response: Response | (() => Response), apiKey: string | null = "sk-ds") {
  const fetch = vi.fn(async () => (typeof response === "function" ? response() : response));
  return {
    fetch,
    backend: makeDeepseekBackend({
      apiKey: apiKey ?? undefined,
      fetch: fetch as typeof globalThis.fetch,
    }),
  };
}

function sentRequest(fetch: ReturnType<typeof vi.fn>) {
  const [url, init] = fetch.mock.calls[0] as [string, RequestInit];
  return { url, init, body: JSON.parse(init.body as string) as Record<string, unknown> };
}

describe("mapDeepseekResults", () => {
  it("prefers summary, falls back to snippet, and maps date to publishedDate", () => {
    expect(
      mapDeepseekResults({
        results: [
          {
            title: "A",
            url: "https://a",
            snippet: "short",
            summary: "long summary",
            date: "2026-10-01T00:00:00Z",
          },
          { title: "B", url: "https://b", snippet: "only snippet", summary: "", date: null },
        ],
      }),
    ).toEqual([
      {
        title: "A",
        url: "https://a",
        snippet: "long summary",
        publishedDate: "2026-10-01T00:00:00Z",
      },
      { title: "B", url: "https://b", snippet: "only snippet" },
    ]);
  });
  it("falls back to the url for an empty title and skips entries without url", () => {
    expect(
      mapDeepseekResults({ results: [{ title: "", url: "https://c" }, { title: "no url" }] }),
    ).toEqual([{ title: "https://c", url: "https://c", snippet: "" }]);
  });
  it("throws on an unexpected shape so the service falls back", () => {
    expect(() => mapDeepseekResults({ data: [] })).toThrow();
  });
});

describe("DeepSeek backend search", () => {
  it("posts the query with a bearer token and maps the results", async () => {
    const { fetch, backend } = backendWith(
      json({ results: [{ title: "A", url: "https://a", summary: "s" }] }),
    );
    await expect(backend.search("marginalia", { numResults: 5 })).resolves.toEqual([
      { title: "A", url: "https://a", snippet: "s" },
    ]);
    const { url, init, body } = sentRequest(fetch);
    expect(url).toBe("https://api.deepseek.com/v1/tools/search");
    expect(init.method).toBe("POST");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer sk-ds");
    expect(body).toEqual({ query: "marginalia", count: 5 });
  });
  it("omits count when numResults is not given", async () => {
    const { fetch, backend } = backendWith(json({ results: [] }));
    await expect(backend.search("q", {})).resolves.toEqual([]);
    expect(sentRequest(fetch).body).toEqual({ query: "q" });
  });
  it("truncates long queries by code point, keeping CJK and emoji intact", async () => {
    const { fetch, backend } = backendWith(json({ results: [] }));
    const query = "书".repeat(DEEPSEEK_SEARCH_QUERY_MAX - 1) + "😀😀";
    await backend.search(query, {});
    const sent = sentRequest(fetch).body.query as string;
    expect(Array.from(sent)).toHaveLength(DEEPSEEK_SEARCH_QUERY_MAX);
    expect(sent.endsWith("书😀")).toBe(true);
  });
  it("surfaces the API error message with the HTTP status", async () => {
    const { backend } = backendWith(
      json({ error: { message: "Insufficient Balance", type: "x", param: null, code: "y" } }, 402),
    );
    await expect(backend.search("q", {})).rejects.toThrow(
      "DeepSeek search failed (HTTP 402): Insufficient Balance",
    );
  });
  it("falls back to the raw body when the error is not JSON", async () => {
    const { backend } = backendWith(new Response("upstream timeout", { status: 504 }));
    await expect(backend.search("q", {})).rejects.toThrow("(HTTP 504): upstream timeout");
  });
  it("throws without sending a request when no API key is configured", async () => {
    const { fetch, backend } = backendWith(json({ results: [] }), null);
    await expect(backend.search("q", {})).rejects.toThrow(/API key is not configured/);
    expect(fetch).not.toHaveBeenCalled();
  });
  it("passes an abort signal that follows the caller's signal", async () => {
    const { fetch, backend } = backendWith(json({ results: [] }));
    const controller = new AbortController();
    await backend.search("q", { signal: controller.signal });
    const signal = sentRequest(fetch).init.signal as AbortSignal;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });
});

describe("DeepSeek backend fetchPage", () => {
  it("posts the url and returns title + markdown content", async () => {
    const { fetch, backend } = backendWith(json({ title: "Doc", content: "# Hello" }));
    await expect(backend.fetchPage!("https://a/doc", {})).resolves.toEqual({
      title: "Doc",
      content: "# Hello",
    });
    const { url, body } = sentRequest(fetch);
    expect(url).toBe("https://api.deepseek.com/v1/tools/fetch");
    expect(body).toEqual({ url: "https://a/doc" });
  });
  it("uses an empty title when the page has none", async () => {
    const { backend } = backendWith(json({ title: null, content: "text" }));
    await expect(backend.fetchPage!("https://a", {})).resolves.toEqual({
      title: "",
      content: "text",
    });
  });
  it("reports 404 with the API message", async () => {
    const { backend } = backendWith(json({ error: { message: "No usable content" } }, 404));
    await expect(backend.fetchPage!("https://a", {})).rejects.toThrow(
      "DeepSeek fetch failed (HTTP 404): No usable content",
    );
  });
});
