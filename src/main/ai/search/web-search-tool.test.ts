import { describe, it, expect, vi } from "vitest";
import { makeWebSearchTool } from "@main/ai/search/web-search-tool";
import { SearchService } from "@main/ai/search/search-service";

function svcReturning(hits: unknown) {
  const search = vi.fn().mockResolvedValue(hits);
  const close = vi.fn();
  const svc = { search, close } as unknown as SearchService;
  return { svc, search, close };
}

async function run(tool: ReturnType<typeof makeWebSearchTool>, input: { query: string }) {
  return (tool.execute as (i: unknown, o: unknown) => Promise<unknown>)(input, {
    toolCallId: "t1",
    messages: [],
  });
}

describe("web_search tool", () => {
  it("returns { results } when enabled and service succeeds", async () => {
    const { svc } = svcReturning([{ title: "A", url: "https://a", snippet: "s" }]);
    await expect(run(makeWebSearchTool(svc, true), { query: "q" })).resolves.toEqual({
      results: [{ title: "A", url: "https://a", snippet: "s" }],
    });
  });
  it("early-returns { error } and never calls the service when turn is disabled", async () => {
    const { svc, search } = svcReturning([]);
    const out = await run(makeWebSearchTool(svc, false), { query: "q" });
    expect(out).toHaveProperty("error");
    expect(search).not.toHaveBeenCalled();
  });
  it("maps service failure to a soft { error } result", async () => {
    const search = vi.fn().mockRejectedValue(new Error("all failed"));
    const close = vi.fn();
    const svc = { search, close } as unknown as SearchService;
    const out = await run(makeWebSearchTool(svc, true), { query: "q" });
    expect(out).toHaveProperty("error");
  });
});
