import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { buildStreamdownTranslations } from "./LocalizedStreamdown";

describe("buildStreamdownTranslations", () => {
  it("maps external-link modal labels through i18n", () => {
    const t = ((key: string) =>
      ({
        "streamdown.close": "关闭",
        "streamdown.copied": "已复制",
        "streamdown.copyLink": "复制链接",
        "streamdown.externalLinkWarning": "即将访问外部网站。",
        "streamdown.openExternalLink": "打开外部链接？",
        "streamdown.openLink": "打开链接",
      })[key] ?? key) as TFunction;

    expect(buildStreamdownTranslations(t)).toMatchObject({
      close: "关闭",
      copied: "已复制",
      copyLink: "复制链接",
      externalLinkWarning: "即将访问外部网站。",
      openExternalLink: "打开外部链接？",
      openLink: "打开链接",
    });
  });
});
