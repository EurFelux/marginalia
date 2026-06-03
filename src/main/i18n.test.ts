import { describe, expect, it } from "vitest";
import { initMainI18n, setMainLanguage, t } from "@main/i18n";

describe("main i18n", () => {
  it("translates errors per active language and switches at runtime", () => {
    initMainI18n("zh-CN");
    expect(t("errors.providerNotFound", { id: "p1" })).toBe("未找到 provider p1");
    setMainLanguage("en");
    expect(t("errors.providerNotFound", { id: "p1" })).toBe("Provider p1 not found");
  });
});
