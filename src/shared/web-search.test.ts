import { describe, it, expect } from "vitest";
import { webSearchBackend, webSearchConfig, DEFAULT_WEB_SEARCH } from "@shared/web-search";

describe("webSearchBackend", () => {
  it("accepts an exa-mcp backend with apiKey", () => {
    expect(webSearchBackend.safeParse({ kind: "exa-mcp", apiKey: "sk-test" }).success).toBe(true);
  });
  it("accepts an exa-mcp backend without apiKey (free tier)", () => {
    expect(webSearchBackend.safeParse({ kind: "exa-mcp" }).success).toBe(true);
  });
  it("accepts a generic mcp backend with url + toolName", () => {
    expect(
      webSearchBackend.safeParse({
        kind: "mcp",
        url: "https://example.com/mcp",
        toolName: "search",
      }).success,
    ).toBe(true);
  });
  it("rejects a generic mcp backend with a non-URL", () => {
    expect(
      webSearchBackend.safeParse({ kind: "mcp", url: "not-a-url", toolName: "search" }).success,
    ).toBe(false);
  });
  it("rejects an unknown kind", () => {
    expect(webSearchBackend.safeParse({ kind: "brave", apiKey: "x" }).success).toBe(false);
  });
});

describe("webSearchConfig", () => {
  it("accepts enabled + ordered backends", () => {
    expect(
      webSearchConfig.safeParse({ enabled: true, backends: [{ kind: "exa-mcp", apiKey: "sk" }] })
        .success,
    ).toBe(true);
  });
  it("accepts the empty default", () => {
    expect(webSearchConfig.safeParse({ enabled: false, backends: [] }).success).toBe(true);
  });
});

describe("DEFAULT_WEB_SEARCH", () => {
  it("parses successfully (out-of-the-box keyless Exa)", () => {
    const result = webSearchConfig.safeParse(DEFAULT_WEB_SEARCH);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.enabled).toBe(true);
      expect(result.data.backends).toHaveLength(1);
      expect(result.data.backends[0]?.kind).toBe("exa-mcp");
    }
  });
});
