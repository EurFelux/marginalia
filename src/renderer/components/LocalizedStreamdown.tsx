import { useMemo } from "react";
import type { TFunction } from "i18next";
import { useTranslation } from "react-i18next";
import { Streamdown, type StreamdownProps, type StreamdownTranslations } from "streamdown";

export function buildStreamdownTranslations(t: TFunction): Partial<StreamdownTranslations> {
  return {
    close: t("streamdown.close", "Close"),
    copied: t("streamdown.copied", "Copied"),
    copyLink: t("streamdown.copyLink", "Copy link"),
    externalLinkWarning: t(
      "streamdown.externalLinkWarning",
      "You're about to visit an external website.",
    ),
    openExternalLink: t("streamdown.openExternalLink", "Open external link?"),
    openLink: t("streamdown.openLink", "Open link"),
  };
}

export function LocalizedStreamdown({ translations, ...props }: StreamdownProps) {
  const { t } = useTranslation();
  const localized = useMemo(() => buildStreamdownTranslations(t), [t]);
  return <Streamdown translations={{ ...localized, ...translations }} {...props} />;
}
