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
import { aiSdkTester } from "@main/secrets/ai-sdk-tester";
import { bind, register, type Binding } from "@main/ipc/registry";
import type { ListModelsResult } from "@shared/providers";

export const settingsBindings: Binding[] = [
  bind(C.providersList, () => listProviders(getDb())),

  bind(C.providersUpsert, (input) => upsertProvider(getDb(), input)),

  bind(C.providersReveal, (input) => ({ apiKey: revealProviderKey(getDb(), input.id) })),

  bind(C.providersTest, (input) => testProvider(getDb(), aiSdkTester, input.id, input.model)),

  bind(C.providersRemove, (input) => removeProvider(getDb(), input.id)),

  bind(C.providersListModels, async (input): Promise<ListModelsResult> => {
    let apiKey: string;
    try {
      apiKey = input.apiKey ?? revealProviderKey(getDb(), input.id ?? "");
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
  }),
];

export function registerSettingsHandlers(): void {
  register(settingsBindings);
}
