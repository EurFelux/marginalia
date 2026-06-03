import { net } from "electron";
import { C } from "@shared/ipc";
import { t } from "@main/i18n";
import { fetchProviderModels, mapModelsError } from "@main/providers/provider-models";
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
import { bind, register, type Binding } from "@main/ipc/registry";

export const settingsBindings: Binding[] = [
  bind(C.providersList, () => listProviders(getDb(), safeStorageEncryptor)),

  bind(C.providersUpsert, (input) => upsertProvider(getDb(), safeStorageEncryptor, input)),

  bind(C.providersReveal, (input) => ({
    apiKey: revealProviderKey(getDb(), safeStorageEncryptor, input.id),
  })),

  bind(C.providersTest, (input) =>
    testProvider(getDb(), safeStorageEncryptor, aiSdkTester, input.id, input.model),
  ),

  bind(C.providersRemove, (input) => removeProvider(getDb(), input.id)),

  bind(C.providersListModels, async (input) => {
    let apiKey: string;
    try {
      apiKey = input.apiKey ?? revealProviderKey(getDb(), safeStorageEncryptor, input.id ?? "");
    } catch {
      return {
        ok: false as const,
        message: t("errors.noApiKeyAvailable", "该$t(terms.provider)无可用密钥"),
      };
    }
    try {
      const netFetch: typeof fetch = (url, init) => net.fetch(url as string, init);
      const models = await fetchProviderModels(
        { type: input.type, baseUrl: input.baseUrl ?? null, apiKey },
        netFetch,
      );
      return { ok: true as const, models };
    } catch (err) {
      return { ok: false as const, ...mapModelsError(err, undefined) };
    }
  }),

  bind(C.assistantGetDefault, () => getDefaultAssistant(getDb())),

  bind(C.assistantUpdate, (input) => updateDefaultAssistant(getDb(), input)),
];

export function registerSettingsHandlers(): void {
  register(settingsBindings);
}
