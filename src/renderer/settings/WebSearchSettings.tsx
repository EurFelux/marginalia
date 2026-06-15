import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { Input } from "@renderer/components/ui/input";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Button } from "@renderer/components/ui/button";
import { DEFAULT_WEB_SEARCH, type WebSearchConfig } from "@shared/web-search";

export function WebSearchSettings() {
  const { t } = useTranslation();
  const webSearch = usePrefsStore((s) => s.webSearch);
  const setWebSearch = usePrefsStore((s) => s.setWebSearch);
  const cfg: WebSearchConfig = webSearch ?? DEFAULT_WEB_SEARCH;
  const exa = cfg.backends.find((b) => b.kind === "exa-mcp");
  const [apiKey, setApiKey] = useState(exa && "apiKey" in exa ? (exa.apiKey ?? "") : "");

  // setWebSearch already calls persistPreference internally (same idiom as all other prefs setters)
  // When toggling, always keep a keyless-or-keyed exa-mcp backend present so web search stays usable.
  const exaBackend = (key: string) =>
    key ? { kind: "exa-mcp" as const, apiKey: key } : { kind: "exa-mcp" as const };
  const onToggle = (enabled: boolean) => setWebSearch({ enabled, backends: [exaBackend(apiKey)] });
  const onSaveKey = () => setWebSearch({ ...cfg, backends: [exaBackend(apiKey)] });

  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg">{t("settings.webSearch", "联网搜索")}</h2>
      <div className="flex items-start justify-between gap-3">
        <label htmlFor="ws-enable" className="min-w-0 cursor-pointer">
          <span className="block text-sm font-medium">
            {t("settings.webSearch.enable", "启用联网搜索")}
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "settings.webSearch.enableHint",
              "允许 AI 在你逐条勾选「联网」时检索外部信息（Exa）。",
            )}
          </span>
        </label>
        <Checkbox
          id="ws-enable"
          checked={cfg.enabled}
          onCheckedChange={(v) => onToggle(v === true)}
          className="mt-0.5"
        />
      </div>
      <div className="space-y-2">
        <label htmlFor="ws-apikey" className="min-w-0">
          <span className="block text-xs text-muted-foreground">
            {t("settings.webSearch.apiKey", "Exa API Key")}
            <span className="ml-1 text-muted-foreground/60">
              {t("settings.webSearch.apiKeyOptional", "（可选）")}
            </span>
          </span>
          <span className="mt-0.5 block text-[11px] leading-relaxed text-muted-foreground">
            {t(
              "settings.webSearch.apiKeyHint",
              "免费层无需 API Key 即可使用；填入 Key 可提升速率限制与结果质量。",
            )}
          </span>
        </label>
        <div className="flex items-center gap-2">
          <Input
            id="ws-apikey"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder={t("settings.webSearch.apiKeyPlaceholder", "exa-…（留空即用免费层）")}
          />
          <Button type="button" variant="outline" size="sm" onClick={onSaveKey}>
            {t("common.save", "保存")}
          </Button>
        </div>
      </div>
    </section>
  );
}
