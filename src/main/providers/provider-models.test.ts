import { describe, expect, it } from "vitest";
import { buildModelsRequest, adaptModelsResponse } from "@main/providers/provider-models";

describe("buildModelsRequest", () => {
  it("openai: /models with Bearer; default base", () => {
    const r = buildModelsRequest("openai", null, "sk-x");
    expect(r.url).toBe("https://api.openai.com/v1/models");
    expect(r.headers.Authorization).toBe("Bearer sk-x");
  });
  it("anthropic: /v1/models with x-api-key + version", () => {
    const r = buildModelsRequest("anthropic", null, "sk-y");
    expect(r.url).toBe("https://api.anthropic.com/v1/models");
    expect(r.headers["x-api-key"]).toBe("sk-y");
    expect(r.headers["anthropic-version"]).toBe("2023-06-01");
  });
  it("google: /models?key=", () => {
    const r = buildModelsRequest("google", null, "k1");
    expect(r.url).toBe("https://generativelanguage.googleapis.com/v1beta/models?key=k1");
  });
  it("openai-compatible: uses given base; throws when base missing", () => {
    expect(buildModelsRequest("openai-compatible", "https://gw/v1", "sk-z").url).toBe(
      "https://gw/v1/models",
    );
    expect(() => buildModelsRequest("openai-compatible", null, "sk-z")).toThrow();
  });
  it("strips trailing slash on base to avoid //models", () => {
    expect(buildModelsRequest("openai-compatible", "https://gw/v1/", "sk").url).toBe(
      "https://gw/v1/models",
    );
  });
});

describe("adaptModelsResponse", () => {
  it("openai/anthropic: data[].id", () => {
    expect(
      adaptModelsResponse("openai", { data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }),
    ).toEqual(["gpt-4o", "gpt-4o-mini"]);
    expect(adaptModelsResponse("anthropic", { data: [{ id: "claude-3-5-haiku-latest" }] })).toEqual(
      ["claude-3-5-haiku-latest"],
    );
  });
  it("google: strips models/ prefix and filters generateContent", () => {
    const json = {
      models: [
        { name: "models/gemini-1.5-flash", supportedGenerationMethods: ["generateContent"] },
        { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
      ],
    };
    expect(adaptModelsResponse("google", json)).toEqual(["gemini-1.5-flash"]);
  });
  it("google: includes a model lacking supportedGenerationMethods (don't silently drop)", () => {
    expect(adaptModelsResponse("google", { models: [{ name: "models/gemini-x" }] })).toEqual([
      "gemini-x",
    ]);
  });
  it("strict types throw on malformed response", () => {
    expect(() => adaptModelsResponse("openai", { foo: 1 })).toThrow();
    expect(() => adaptModelsResponse("anthropic", { data: "x" })).toThrow();
  });
  it("openai-compatible best-effort: salvages valid ids, tolerates junk, [] when no data", () => {
    expect(
      adaptModelsResponse("openai-compatible", { data: [{ id: "a", extra: 1 }, { noId: true }] }),
    ).toEqual(["a"]);
    expect(adaptModelsResponse("openai-compatible", { whatever: 1 })).toEqual([]);
  });
});
