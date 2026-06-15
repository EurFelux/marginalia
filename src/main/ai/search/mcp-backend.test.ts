import { describe, it, expect } from "vitest";
import {
  mapExaResult,
  exaBackendOpts,
  genericBackendOpts,
  backendOptsFor,
} from "@main/ai/search/mcp-backend";

// Real formatted-text fixture matching the actual Exa MCP web_search_exa response shape
// (structuredContent: NONE — the text field is plain formatted text, NOT JSON).
const EXA_TEXT = `Title: U.S. orders Anthropic to 'suspend all access' of latest AI models
URL: https://tech.yahoo.com/ai/article/us-orders-anthropic-to-suspend-all-access-of-latest-ai-models-181826834.html
Published: 2026-06-15T18:18:26.000Z
Author: N/A
Highlights:
U.S. orders Anthropic to 'suspend all access' of latest AI models
Anthropic was scrambling on Monday to deal with the fallout of the government order.

---

Title: U.S. order cutting access to Anthropic's AI models sparks criticism - The Hindu
URL: https://www.thehindu.com/sci-tech/technology/us-order-cutting-access-to-anthropics-ai-models-sparks-criticism/article69694738.ece
Published: 2026-06-15T03:59:12.000Z
Author: AFP
Highlights:
# U.S. order cutting access to Anthropic's AI models sparks criticism
The U.S. government's order for Anthropic to withdraw its AI models has sparked sharp criticism from the tech industry.`;

const EXA_CONTENT = [{ type: "text" as const, text: EXA_TEXT }];

describe("mapExaResult", () => {
  it("parses a 2-block formatted-text response into SearchHit[]", () => {
    const hits = mapExaResult({ content: EXA_CONTENT });
    expect(hits).toHaveLength(2);

    expect(hits[0]).toMatchObject({
      title: "U.S. orders Anthropic to 'suspend all access' of latest AI models",
      url: "https://tech.yahoo.com/ai/article/us-orders-anthropic-to-suspend-all-access-of-latest-ai-models-181826834.html",
      publishedDate: "2026-06-15T18:18:26.000Z",
    });
    expect(hits[0]?.snippet).toContain("Anthropic was scrambling");

    expect(hits[1]).toMatchObject({
      title: "U.S. order cutting access to Anthropic's AI models sparks criticism - The Hindu",
      url: "https://www.thehindu.com/sci-tech/technology/us-order-cutting-access-to-anthropics-ai-models-sparks-criticism/article69694738.ece",
      publishedDate: "2026-06-15T03:59:12.000Z",
    });
    expect(hits[1]?.snippet).toContain("sparked sharp criticism");
  });

  it("omits publishedDate when Author is N/A but date is present (date still kept)", () => {
    // Author N/A → ignored; the date from block 0 should still be present
    const hits = mapExaResult({ content: EXA_CONTENT });
    expect(hits[0]?.publishedDate).toBe("2026-06-15T18:18:26.000Z");
  });

  it("omits publishedDate when Published is N/A", () => {
    const noDate = `Title: Test
URL: https://example.com
Published: N/A
Author: Someone
Highlights:
Some highlight text`;
    const hits = mapExaResult({ content: [{ type: "text" as const, text: noDate }] });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.publishedDate).toBeUndefined();
  });

  it("falls back to URL as title when Title line is missing", () => {
    const noTitle = `URL: https://example.com/notitle
Published: 2026-01-01T00:00:00.000Z
Highlights:
Some content`;
    const hits = mapExaResult({ content: [{ type: "text" as const, text: noTitle }] });
    expect(hits[0]?.title).toBe("https://example.com/notitle");
  });

  it("skips blocks with no URL", () => {
    const noUrl = `Title: No URL block
Published: 2026-01-01T00:00:00.000Z
Highlights:
Content without URL`;
    const hits = mapExaResult({ content: [{ type: "text" as const, text: noUrl }] });
    expect(hits).toHaveLength(0);
  });

  it("throws on malformed envelope (empty content array)", () => {
    expect(() => mapExaResult({ content: [] })).toThrow();
  });

  it("throws on malformed envelope (missing content key)", () => {
    expect(() => mapExaResult({ foo: "bar" })).toThrow();
  });
});

describe("backend opts builders", () => {
  it("exaBackendOpts with key sets x-api-key header", () => {
    const o = exaBackendOpts("sk-123");
    expect(o.url).toContain("mcp.exa.ai/mcp");
    expect(o.url).toContain("tools=web_search_exa");
    expect(o.headers).toEqual({ "x-api-key": "sk-123" });
    expect(o.toolName).toBe("web_search_exa");
  });

  it("exaBackendOpts without key produces empty headers (free tier)", () => {
    const o = exaBackendOpts();
    expect(o.headers).toEqual({});
    expect(o.url).toContain("mcp.exa.ai/mcp");
    expect(o.toolName).toBe("web_search_exa");
  });

  it("exaBackendOpts with undefined key produces empty headers", () => {
    const o = exaBackendOpts(undefined);
    expect(o.headers).toEqual({});
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
  it("dispatches exa-mcp with key to the Exa preset", () => {
    expect(backendOptsFor({ kind: "exa-mcp", apiKey: "k" }).id).toBe("exa-mcp");
  });
  it("dispatches keyless exa-mcp to the Exa preset", () => {
    const o = backendOptsFor({ kind: "exa-mcp" });
    expect(o.id).toBe("exa-mcp");
    expect(o.headers).toEqual({});
  });
  it("dispatches mcp to the generic builder", () => {
    expect(backendOptsFor({ kind: "mcp", url: "https://x/mcp", toolName: "s" }).id).toBe("mcp:x");
  });
});
