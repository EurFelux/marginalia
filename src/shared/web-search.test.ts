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
  it("accepts ordered backends", () => {
    expect(
      webSearchConfig.safeParse({ backends: [{ kind: "exa-mcp", apiKey: "sk" }] }).success,
    ).toBe(true);
  });
  it("accepts empty backends list", () => {
    expect(webSearchConfig.safeParse({ backends: [] }).success).toBe(true);
  });
  it("strips unknown keys (back-compat: old stored { enabled, backends } parses fine)", () => {
    const result = webSearchConfig.safeParse({ enabled: true, backends: [{ kind: "exa-mcp" }] });
    expect(result.success).toBe(true);
    if (result.success) {
      // enabled is stripped; only backends survives
      expect(result.data).not.toHaveProperty("enabled");
      expect(result.data.backends).toHaveLength(1);
    }
  });
});

describe("DEFAULT_WEB_SEARCH", () => {
  it("parses successfully (out-of-the-box keyless Exa)", () => {
    const result = webSearchConfig.safeParse(DEFAULT_WEB_SEARCH);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.backends).toHaveLength(1);
      expect(result.data.backends[0]?.kind).toBe("exa-mcp");
    }
  });
  it("DEFAULT_WEB_SEARCH equals { backends: [{ kind: 'exa-mcp' }] }", () => {
    expect(DEFAULT_WEB_SEARCH).toEqual({ backends: [{ kind: "exa-mcp" }] });
  });
});
