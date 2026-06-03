import { describe, expect, it } from "vitest";
import {
  LANGS,
  matchSystemLanguage,
  resolveInitialLanguage,
  uiLanguage,
} from "@shared/i18n/language";

describe("uiLanguage / LANGS", () => {
  it("enum covers exactly zh-CN + en, all ltr", () => {
    expect(uiLanguage.options).toEqual(["zh-CN", "en"]);
    expect(LANGS.map((l) => l.code).sort()).toEqual(["en", "zh-CN"]);
    expect(LANGS.every((l) => l.dir === "ltr")).toBe(true);
  });
});

describe("matchSystemLanguage", () => {
  it("maps any zh* locale to zh-CN, else en", () => {
    for (const loc of ["zh", "zh-CN", "zh-TW", "zh-HK", "ZH-cn"]) {
      expect(matchSystemLanguage(loc)).toBe("zh-CN");
    }
    for (const loc of ["en", "en-US", "de", "fr-FR", ""]) {
      expect(matchSystemLanguage(loc)).toBe("en");
    }
  });
});

describe("resolveInitialLanguage", () => {
  it("prefers stored, falls back to system match", () => {
    expect(resolveInitialLanguage("en", "zh-CN")).toBe("en");
    expect(resolveInitialLanguage(undefined, "zh-TW")).toBe("zh-CN");
    expect(resolveInitialLanguage(undefined, "fr")).toBe("en");
  });
});
