import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { Input } from "@renderer/components/ui/input";
import { Checkbox } from "@renderer/components/ui/checkbox";
import { Button } from "@renderer/components/ui/button";
import type { WebSearchConfig } from "@shared/web-search";

export function WebSearchSettings() {
  const { t } = useTranslation();
  const webSearch = usePrefsStore((s) => s.webSearch);
  const setWebSearch = usePrefsStore((s) => s.setWebSearch);
  const cfg: WebSearchConfig = webSearch ?? { enabled: false, backends: [] };
  const exa = cfg.backends.find((b) => b.kind === "exa-mcp");
  const [apiKey, setApiKey] = useState(exa && "apiKey" in exa ? exa.apiKey : "");

  // setWebSearch already calls persistPreference internally (same idiom as all other prefs setters)
  const onToggle = (enabled: boolean) => setWebSearch({ ...cfg, enabled });
  const onSaveKey = () =>
    setWebSearch({ ...cfg, backends: apiKey ? [{ kind: "exa-mcp", apiKey }] : [] });

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
        <span className="text-xs text-muted-foreground">
          {t("settings.webSearch.apiKey", "Exa API Key")}
        </span>
        <div className="flex items-center gap-2">
          <Input
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            placeholder="exa-…"
          />
          <Button type="button" variant="outline" size="sm" onClick={onSaveKey}>
            {t("common.save", "保存")}
          </Button>
        </div>
      </div>
    </section>
  );
}
