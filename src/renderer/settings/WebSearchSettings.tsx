import { useState } from "react";
import { useTranslation } from "react-i18next";
import { usePrefsStore } from "@renderer/store/prefs-store";
import { Input } from "@renderer/components/ui/input";
import { Button } from "@renderer/components/ui/button";
import { DEFAULT_WEB_SEARCH, type WebSearchConfig } from "@shared/web-search";

export function WebSearchSettings() {
  const { t } = useTranslation();
  const webSearch = usePrefsStore((s) => s.webSearch);
  const setWebSearch = usePrefsStore((s) => s.setWebSearch);
  const cfg: WebSearchConfig = webSearch ?? DEFAULT_WEB_SEARCH;
  const exa = cfg.backends.find((b) => b.kind === "exa-mcp");
  const [apiKey, setApiKey] = useState(exa && "apiKey" in exa ? (exa.apiKey ?? "") : "");

  const exaBackend = (key: string) =>
    key ? { kind: "exa-mcp" as const, apiKey: key } : { kind: "exa-mcp" as const };
  const onSaveKey = () => setWebSearch({ backends: [exaBackend(apiKey)] });

  return (
    <section className="space-y-4">
      <h2 className="font-serif text-lg">{t("settings.webSearch", "联网搜索")}</h2>
      <p className="text-[11px] leading-relaxed text-muted-foreground">
        {t(
          "settings.webSearch.description",
          "联网搜索默认可用（Exa），用 AI 面板的「联网」按钮启用或关闭。",
        )}
      </p>
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
