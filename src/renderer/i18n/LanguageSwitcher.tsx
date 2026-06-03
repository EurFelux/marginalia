import { useTranslation } from "react-i18next";
import { LANGS, uiLanguage } from "@shared/i18n/language";
import { changeUiLanguage } from "@renderer/i18n";
import { ToggleGroup, ToggleGroupItem } from "@renderer/components/ui/toggle-group";

export function LanguageSwitcher() {
  const { i18n } = useTranslation();
  return (
    <ToggleGroup
      value={[i18n.language]}
      onValueChange={(g) => {
        const parsed = uiLanguage.safeParse(g[0]);
        if (parsed.success) changeUiLanguage(parsed.data);
      }}
      variant="outline"
      size="sm"
    >
      {LANGS.map((l) => (
        <ToggleGroupItem key={l.code} value={l.code}>
          {l.label}
        </ToggleGroupItem>
      ))}
    </ToggleGroup>
  );
}
