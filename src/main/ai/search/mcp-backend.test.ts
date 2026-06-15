import { describe, it, expect } from "vitest";
import {
  mapExaResult,
  exaBackendOpts,
  genericBackendOpts,
  backendOptsFor,
} from "@main/ai/search/mcp-backend";

// NOTE: EXA_CONTENT shape is ASSUMED from Exa MCP docs and will be reconciled
// against a real Exa call during smoke testing (a later task). The callTool
// argument names (query, numResults) are similarly assumed from Exa's tool schema.
const EXA_CONTENT = [
  {
    type: "text",
    text: JSON.stringify({
      results: [
        { title: "A", url: "https://a.com", text: "snippet a", publishedDate: "2026-01-01" },
        { title: "B", url: "https://b.com", text: "snippet b" },
      ],
    }),
  },
];

describe("mapExaResult", () => {
  it("maps Exa MCP content to SearchHit[]", () => {
    expect(mapExaResult({ content: EXA_CONTENT })).toEqual([
      { title: "A", url: "https://a.com", snippet: "snippet a", publishedDate: "2026-01-01" },
      { title: "B", url: "https://b.com", snippet: "snippet b" },
    ]);
  });
  it("throws on malformed content", () => {
    expect(() => mapExaResult({ content: [{ type: "text", text: "not json" }] })).toThrow();
    expect(() => mapExaResult({ content: [] })).toThrow();
  });
});

describe("backend opts builders", () => {
  it("exaBackendOpts sets the Exa url, x-api-key header, and tool", () => {
    const o = exaBackendOpts("sk-123");
    expect(o.url).toContain("mcp.exa.ai/mcp");
    expect(o.url).toContain("tools=web_search_exa");
    expect(o.headers).toEqual({ "x-api-key": "sk-123" });
    expect(o.toolName).toBe("web_search_exa");
  });
  it("genericBackendOpts honors custom header name + tool", () => {
    const o = genericBackendOpts({
      kind: "mcp",
      url: "https://x/mcp",
      toolName: "s",
      apiKeyHeader: "authorization",
      apiKey: "k",
    });
    expect(o.headers).toEqual({ authorization: "k" });
    expect(o.toolName).toBe("s");
  });
});

describe("backendOptsFor", () => {
  it("dispatches exa-mcp to the Exa preset", () => {
    expect(backendOptsFor({ kind: "exa-mcp", apiKey: "k" }).id).toBe("exa-mcp");
  });
  it("dispatches mcp to the generic builder", () => {
    expect(backendOptsFor({ kind: "mcp", url: "https://x/mcp", toolName: "s" }).id).toBe("mcp:x");
  });
});
