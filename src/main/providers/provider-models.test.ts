import { beforeAll, describe, expect, it } from "vitest";
import {
  buildModelsRequest,
  adaptModelsResponse,
  fetchProviderModels,
  mapModelsError,
} from "@main/providers/provider-models";
import { initMainI18n } from "@main/i18n";

beforeAll(() => initMainI18n("en"));

describe("buildModelsRequest", () => {
  it("openai: /models with Bearer; default base", () => {
    const r = buildModelsRequest("openai-responses", null, "sk-x");
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
    const r = buildModelsRequest("google-generate-content", null, "k1");
    expect(r.url).toBe("https://generativelanguage.googleapis.com/v1beta/models?key=k1");
  });
  it("openai-compatible: uses given base; throws when base missing", () => {
    expect(buildModelsRequest("openai-chat-completions", "https://gw/v1", "sk-z").url).toBe(
      "https://gw/v1/models",
    );
    expect(() => buildModelsRequest("openai-chat-completions", null, "sk-z")).toThrow();
  });
  it("strips trailing slash on base to avoid //models", () => {
    expect(buildModelsRequest("openai-chat-completions", "https://gw/v1/", "sk").url).toBe(
      "https://gw/v1/models",
    );
  });
});

describe("adaptModelsResponse", () => {
  it("openai/anthropic: data[].id", () => {
    expect(
      adaptModelsResponse("openai-responses", { data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] }),
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
    expect(adaptModelsResponse("google-generate-content", json)).toEqual(["gemini-1.5-flash"]);
  });
  it("google: includes a model lacking supportedGenerationMethods (don't silently drop)", () => {
    expect(
      adaptModelsResponse("google-generate-content", { models: [{ name: "models/gemini-x" }] }),
    ).toEqual(["gemini-x"]);
  });
  it("openai/anthropic: filters out non-text models (image/tts/whisper/embedding/moderation)", () => {
    expect(
      adaptModelsResponse("openai-responses", {
        data: [
          { id: "gpt-4o" },
          { id: "o3-mini" },
          { id: "dall-e-3" },
          { id: "gpt-image-1" },
          { id: "tts-1" },
          { id: "gpt-4o-mini-tts" },
          { id: "whisper-1" },
          { id: "gpt-4o-transcribe" },
          { id: "text-embedding-3-small" },
          { id: "omni-moderation-latest" },
        ],
      }),
    ).toEqual(["gpt-4o", "o3-mini"]);
  });
  it("openai-compatible: also filters non-text models, keeps unknown chat ids", () => {
    expect(
      adaptModelsResponse("openai-chat-completions", {
        data: [{ id: "llama-3.1-70b" }, { id: "nomic-embed-text" }, { id: "bge-reranker-v2" }],
      }),
    ).toEqual(["llama-3.1-70b"]);
  });
  it("strict types throw on malformed response", () => {
    expect(() => adaptModelsResponse("openai-responses", { foo: 1 })).toThrow();
    expect(() => adaptModelsResponse("anthropic", { data: "x" })).toThrow();
  });
  it("openai-compatible best-effort: salvages valid ids, tolerates junk, [] when no data", () => {
    expect(
      adaptModelsResponse("openai-chat-completions", {
        data: [{ id: "a", extra: 1 }, { noId: true }],
      }),
    ).toEqual(["a"]);
    expect(adaptModelsResponse("openai-chat-completions", { whatever: 1 })).toEqual([]);
  });
});

function jsonResponse(body: unknown, init?: { status?: number; ok?: boolean }): Response {
  const status = init?.status ?? 200;
  return {
    ok: init?.ok ?? status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

describe("fetchProviderModels", () => {
  it("returns adapted ids on 200", async () => {
    const fetchImpl = async () => jsonResponse({ data: [{ id: "gpt-4o" }] });
    await expect(
      fetchProviderModels(
        { type: "openai-responses", baseUrl: null, apiKey: "sk" },
        fetchImpl as typeof fetch,
      ),
    ).resolves.toEqual(["gpt-4o"]);
  });
  it("throws with provider message on non-2xx", async () => {
    const fetchImpl = async () =>
      jsonResponse({ error: { message: "bad key" } }, { status: 401, ok: false });
    await expect(
      fetchProviderModels(
        { type: "openai-responses", baseUrl: null, apiKey: "x" },
        fetchImpl as typeof fetch,
      ),
    ).rejects.toThrow("bad key");
  });
});

describe("mapModelsError", () => {
  it("transparent provider message wins", () => {
    expect(mapModelsError(new Error("boom"), undefined).message).toContain("boom");
  });
  it("stringifies non-Error throws", () => {
    expect(mapModelsError("oops", undefined).message).toContain("oops");
  });
  it("falls back to HTTP semantics by status when no error", () => {
    expect(mapModelsError(undefined, 401).message).toContain("API key");
    expect(mapModelsError(undefined, 503).message).toContain("server-side");
    expect(mapModelsError(undefined, 418).message).toBe("HTTP 418");
    expect(mapModelsError(undefined, undefined).message).toBe("Request failed");
  });
});
