// src/main/ai/assistant-model.ts
import type { DB } from "@main/db/client";
import type { Encryptor } from "@main/secrets/encryptor";
import { getDefaultAssistant } from "@main/providers/assistant";
import { loadProvider } from "@main/providers/repository";
import { resolveLanguageModel, type ChatModel } from "@main/ai/model-factory";
import { t } from "@main/i18n";

export type ResolvedModel =
  | { ok: true; model: ChatModel; modelId: string }
  | { ok: false; reason: string };

/** 把默认 Assistant 解析为可调用模型；任一前置缺失返回结构化错误（供发送前友好拦截）。 */
export function resolveAssistantModel(db: DB, encryptor: Encryptor): ResolvedModel {
  const assistant = getDefaultAssistant(db);
  if (!assistant.providerId)
    return { ok: false, reason: t("errors.assistantNoProvider", "助手未配置$t(terms.provider)") };
  if (!assistant.model)
    return { ok: false, reason: t("errors.assistantNoModel", "助手未配置模型") };

  const provider = loadProvider(db, assistant.providerId);
  if (!provider)
    return {
      ok: false,
      reason: t("errors.assistantProviderNotFound", "未找到所配置的$t(terms.provider)"),
    };
  if (!provider.apiKeyEncrypted)
    return { ok: false, reason: t("errors.assistantNoApiKey", "$t(terms.provider)未设置密钥") };
  if (!encryptor.isAvailable())
    return {
      ok: false,
      reason: t("errors.secureStorageUnavailableMachine", "本机安全存储不可用"),
    };

  let apiKey: string;
  try {
    apiKey = encryptor.decrypt(provider.apiKeyEncrypted);
  } catch (err) {
    // 跨机迁移属预期；但真实 encryptor 故障也走这里——记日志以便区分（与 providers/repository 一致）
    console.warn("[assistant-model] decrypt failed:", err);
    return {
      ok: false,
      reason: t("errors.keyUndecryptableMachine", "已存密钥无法在本机解密"),
    };
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
    return {
      ok: false,
      reason: err instanceof Error ? err.message : t("errors.failedToBuildModel", "构建模型失败"),
    };
  }
}
