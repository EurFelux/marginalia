import { describe, expect, it } from "vitest";
import { initMainI18n, setMainLanguage, t } from "@main/i18n";

describe("main i18n", () => {
  it("translates errors per active language and switches at runtime", () => {
    initMainI18n("zh-CN");
    // $t(terms.provider) 嵌套 + {{id}} 插值：术语随语言解析（zh=模型服务商 / en=provider）。
    expect(t("errors.providerNotFound", { id: "p1" })).toBe("未找到模型服务商 p1");
    setMainLanguage("en");
    expect(t("errors.providerNotFound", { id: "p1" })).toBe("provider p1 not found");
  });
});
