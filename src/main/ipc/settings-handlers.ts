import { z } from "zod";
import { net } from "electron";
import { IPC } from "@shared/ipc";
import { t } from "@main/i18n";
import {
  listModelsInput,
  providerIdInput,
  testProviderInput,
  upsertProviderInput,
  type ListModelsInput,
  type ListModelsResult,
  type ProviderDto,
  type RevealResult,
  type TestResult,
  type UpsertProviderInput,
} from "@shared/providers";
import { fetchProviderModels, mapModelsError } from "@main/providers/provider-models";
import {
  updateAssistantInput,
  type AssistantDto,
  type UpdateAssistantInput,
} from "@shared/assistant";
import { getDb } from "@main/db/instance";
import {
  listProviders,
  removeProvider,
  revealProviderKey,
  testProvider,
  upsertProvider,
} from "@main/providers/repository";
import { getDefaultAssistant, updateDefaultAssistant } from "@main/providers/assistant";
import { safeStorageEncryptor } from "@main/secrets/safe-storage-encryptor";
import { aiSdkTester } from "@main/secrets/ai-sdk-tester";
import { handle } from "@main/ipc/registry";

export function registerSettingsHandlers(): void {
  handle<void, ProviderDto[]>(IPC.providersList, z.void(), () =>
    listProviders(getDb(), safeStorageEncryptor),
  );

  handle<UpsertProviderInput, ProviderDto>(IPC.providersUpsert, upsertProviderInput, (input) =>
    upsertProvider(getDb(), safeStorageEncryptor, input),
  );

  handle<{ id: string }, RevealResult>(IPC.providersReveal, providerIdInput, (input) => ({
    apiKey: revealProviderKey(getDb(), safeStorageEncryptor, input.id),
  }));

  handle<{ id: string; model: string }, TestResult>(IPC.providersTest, testProviderInput, (input) =>
    testProvider(getDb(), safeStorageEncryptor, aiSdkTester, input.id, input.model),
  );

  handle<{ id: string }, void>(IPC.providersRemove, providerIdInput, (input) =>
    removeProvider(getDb(), input.id),
  );

  handle<ListModelsInput, ListModelsResult>(
    IPC.providersListModels,
    listModelsInput,
    async (input) => {
      let apiKey: string;
      try {
        apiKey = input.apiKey ?? revealProviderKey(getDb(), safeStorageEncryptor, input.id ?? "");
      } catch {
        return {
          ok: false,
          message: t("errors.noApiKeyAvailable", "该$t(terms.provider)无可用密钥"),
        };
      }
      try {
        const netFetch: typeof fetch = (url, init) => net.fetch(url as string, init);
        const models = await fetchProviderModels(
          { type: input.type, baseUrl: input.baseUrl ?? null, apiKey },
          netFetch,
        );
        return { ok: true, models };
      } catch (err) {
        return { ok: false, ...mapModelsError(err, undefined) };
      }
    },
  );

  handle<void, AssistantDto>(IPC.assistantGetDefault, z.void(), () => getDefaultAssistant(getDb()));

  handle<UpdateAssistantInput, AssistantDto>(IPC.assistantUpdate, updateAssistantInput, (input) =>
    updateDefaultAssistant(getDb(), input),
  );
}
