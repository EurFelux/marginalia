// src/main/ai/assistant-model.ts
import type { DB } from "@main/db/client";
import { getDefaultAssistant } from "@main/providers/assistant";
import { loadProvider } from "@main/providers/repository";
import { resolveLanguageModel, type ChatModel } from "@main/ai/model-factory";
import { t } from "@main/i18n";
import { getPreference } from "@main/preferences/repository";
import type { AiProviderApiType } from "@shared/providers";

export type ResolvedModel =
  | { ok: true; model: ChatModel; modelId: string; providerType?: AiProviderApiType }
  | { ok: false; reason: string };

/** 把默认 Assistant 解析为可调用模型；任一前置缺失返回结构化错误（供发送前友好拦截）。 */
export function resolveAssistantModel(db: DB): ResolvedModel {
  const assistant = getDefaultAssistant(db);
  if (!assistant.providerId)
    return { ok: false, reason: t("errors.assistantNoProvider", "助手未配置$t(terms.provider)") };
  if (!assistant.model)
    return { ok: false, reason: t("errors.assistantNoModel", "助手未配置模型") };

  const provider = loadProvider(db, assistant.providerId);
  if (!provider)
    return {
      ok: false,
      reason: t("errors.configuredProviderNotFound", "未找到所配置的$t(terms.provider)"),
    };
  if (!provider.apiKey)
    return {
      ok: false,
      reason: t("errors.configuredProviderNoApiKey", "$t(terms.provider)未设置密钥"),
    };

  try {
    const model = resolveLanguageModel({
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: assistant.model,
    });
    return { ok: true, model, modelId: assistant.model, providerType: provider.type };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : t("errors.failedToBuildModel", "构建模型失败"),
    };
  }
}

/**
 * 把「摘要模型」偏好解析为可调用模型（章节/全书摘要 + auto naming 共用；spec §4）。
 * 未配置 / provider 已删 / 无密钥一律返回结构化错误——显式报错，绝不回退聊天模型。
 */
export function resolveSummaryModel(db: DB): ResolvedModel {
  const pref = getPreference(db, "summaryModel");
  if (!pref) {
    return { ok: false, reason: t("errors.summaryModelNotConfigured", "未配置摘要模型") };
  }
  const provider = loadProvider(db, pref.providerId);
  if (!provider) {
    return {
      ok: false,
      reason: t("errors.configuredProviderNotFound", "未找到所配置的$t(terms.provider)"),
    };
  }
  if (!provider.apiKey) {
    return {
      ok: false,
      reason: t("errors.configuredProviderNoApiKey", "$t(terms.provider)未设置密钥"),
    };
  }
  try {
    const model = resolveLanguageModel({
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: pref.model,
    });
    return { ok: true, model, modelId: pref.model, providerType: provider.type };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : t("errors.failedToBuildModel", "构建模型失败"),
    };
  }
}
