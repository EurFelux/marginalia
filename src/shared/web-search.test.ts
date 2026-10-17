import { describe, it, expect } from "vitest";
import {
  webSearchBackend,
  webSearchConfig,
  DEFAULT_WEB_SEARCH,
  applyPresetBackendList,
  backendDisplayName,
  backendSupportsFetch,
  enabledBackends,
  presetBackendList,
  webToolNames,
  type WebSearchConfig,
} from "@shared/web-search";

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

describe("deepseek backend kind", () => {
  it("accepts a deepseek backend without apiKey (key comes from the built-in provider)", () => {
    expect(webSearchBackend.safeParse({ kind: "deepseek" }).success).toBe(true);
    expect(webSearchBackend.safeParse({ kind: "deepseek", enabled: false }).success).toBe(true);
  });
});

describe("enabledBackends / webToolNames", () => {
  it("treats a missing enabled flag as enabled", () => {
    expect(enabledBackends({ backends: [{ kind: "exa-mcp" }] })).toHaveLength(1);
  });
  it("drops disabled backends and keeps order", () => {
    const cfg: WebSearchConfig = {
      backends: [{ kind: "deepseek" }, { kind: "exa-mcp", enabled: false }, { kind: "exa-mcp" }],
    };
    expect(enabledBackends(cfg).map((b) => b.kind)).toEqual(["deepseek", "exa-mcp"]);
  });
  it("registers only web_search when no fetch-capable backend is enabled", () => {
    expect(
      webToolNames({ backends: [{ kind: "exa-mcp" }, { kind: "deepseek", enabled: false }] }),
    ).toEqual(["web_search"]);
  });
  it("adds web_fetch when DeepSeek is enabled", () => {
    expect(webToolNames({ backends: [{ kind: "exa-mcp" }, { kind: "deepseek" }] })).toEqual([
      "web_search",
      "web_fetch",
    ]);
  });
  it("registers nothing when every backend is disabled", () => {
    expect(webToolNames({ backends: [{ kind: "exa-mcp", enabled: false }] })).toEqual([]);
    expect(webToolNames({ backends: [] })).toEqual([]);
  });
  it("only DeepSeek supports fetch", () => {
    expect(backendSupportsFetch({ kind: "deepseek" })).toBe(true);
    expect(backendSupportsFetch({ kind: "exa-mcp" })).toBe(false);
  });
});

describe("presetBackendList / applyPresetBackendList", () => {
  const mcp = { kind: "mcp" as const, url: "https://search.example.com/mcp", toolName: "s" };

  it("appends missing presets as disabled, after the configured ones", () => {
    expect(presetBackendList(DEFAULT_WEB_SEARCH)).toEqual([
      { kind: "exa-mcp" },
      { kind: "deepseek", enabled: false },
    ]);
  });
  it("keeps the configured order", () => {
    expect(
      presetBackendList({ backends: [{ kind: "deepseek" }, { kind: "exa-mcp", apiKey: "k" }] }),
    ).toEqual([{ kind: "deepseek" }, { kind: "exa-mcp", apiKey: "k" }]);
  });
  it("leaves mcp entries out and dedupes repeated presets", () => {
    expect(
      presetBackendList({
        backends: [mcp, { kind: "deepseek" }, { kind: "deepseek", enabled: false }],
      }),
    ).toEqual([{ kind: "deepseek" }, { kind: "exa-mcp", enabled: false }]);
  });
  it("writes back the edited presets and keeps mcp entries at the end", () => {
    const cfg: WebSearchConfig = { backends: [{ kind: "exa-mcp" }, mcp] };
    expect(applyPresetBackendList(cfg, [{ kind: "deepseek" }, { kind: "exa-mcp" }])).toEqual({
      backends: [{ kind: "deepseek" }, { kind: "exa-mcp" }, mcp],
    });
  });
});

describe("backendDisplayName", () => {
  it("uses brand names for presets and label or host for mcp", () => {
    expect(backendDisplayName({ kind: "exa-mcp" })).toBe("Exa");
    expect(backendDisplayName({ kind: "deepseek" })).toBe("DeepSeek");
    expect(
      backendDisplayName({ kind: "mcp", url: "https://search.example.com/mcp", toolName: "s" }),
    ).toBe("search.example.com");
    expect(
      backendDisplayName({ kind: "mcp", label: "Mine", url: "https://a.b/mcp", toolName: "s" }),
    ).toBe("Mine");
  });
});
