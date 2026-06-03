// src/main/ai/assistant-model.ts
import type { DB } from "@main/db/client";
import type { Encryptor } from "@main/secrets/encryptor";
import { getDefaultAssistant } from "@main/providers/assistant";
import { loadProvider } from "@main/providers/repository";
import { resolveLanguageModel, type ChatModel } from "@main/ai/model-factory";

export type ResolvedModel =
  | { ok: true; model: ChatModel; modelId: string }
  | { ok: false; reason: string };

/** 把默认 Assistant 解析为可调用模型；任一前置缺失返回结构化错误（供发送前友好拦截）。 */
export function resolveAssistantModel(db: DB, encryptor: Encryptor): ResolvedModel {
  const assistant = getDefaultAssistant(db);
  if (!assistant.providerId) return { ok: false, reason: "assistant has no provider configured" };
  if (!assistant.model) return { ok: false, reason: "assistant has no model configured" };

  const provider = loadProvider(db, assistant.providerId);
  if (!provider) return { ok: false, reason: "configured provider not found" };
  if (!provider.apiKeyEncrypted) return { ok: false, reason: "provider has no API key set" };
  if (!encryptor.isAvailable())
    return { ok: false, reason: "secure storage is unavailable on this machine" };

  let apiKey: string;
  try {
    apiKey = encryptor.decrypt(provider.apiKeyEncrypted);
  } catch (err) {
    // 跨机迁移属预期；但真实 encryptor 故障也走这里——记日志以便区分（与 providers/repository 一致）
    console.warn("[assistant-model] decrypt failed:", err);
    return { ok: false, reason: "stored API key cannot be decrypted on this machine" };
  }

  try {
    const model = resolveLanguageModel({
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKey,
      model: assistant.model,
    });
    return { ok: true, model, modelId: assistant.model };
  } catch (err) {
    return { ok: false, reason: err instanceof Error ? err.message : "failed to build model" };
  }
}
