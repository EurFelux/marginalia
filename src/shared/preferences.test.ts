import { describe, expect, it } from "vitest";
import {
  PREFERENCE_SCHEMAS,
  preferenceKey,
  readerLayoutSchema,
  readerPrefsSchema,
  setPreferenceInput,
} from "@shared/preferences";

describe("preferences schemas", () => {
  it("readerPrefsSchema requires all three numeric fields", () => {
    expect(
      readerPrefsSchema.safeParse({ fontScale: 1, lineHeight: 1.9, maxWidth: 640 }).success,
    ).toBe(true);
    expect(readerPrefsSchema.safeParse({ fontScale: 1, lineHeight: 1.9 }).success).toBe(false);
    expect(
      readerPrefsSchema.safeParse({ fontScale: 1, lineHeight: 1.9, maxWidth: 6.5 }).success,
    ).toBe(false); // maxWidth 须整数
  });

  it("registers exactly the keys with current consumers", () => {
    expect(Object.keys(PREFERENCE_SCHEMAS).sort()).toEqual([
      "autoSummarize",
      "colorMode",
      "language",
      "lastHighlightStyle",
      "readerLayout",
      "readerPrefs",
    ]);
  });

  it("preferenceKey accepts known keys and rejects unknown", () => {
    expect(preferenceKey.safeParse("readerPrefs").success).toBe(true);
    expect(preferenceKey.safeParse("colorMode").success).toBe(true);
    expect(preferenceKey.safeParse("nope").success).toBe(false);
  });

  it("readerLayoutSchema requires all three boolean flags", () => {
    expect(
      readerLayoutSchema.safeParse({ sidebarOpen: true, panelOpen: false, headerOpen: true })
        .success,
    ).toBe(true);
    expect(readerLayoutSchema.safeParse({ sidebarOpen: true, panelOpen: false }).success).toBe(
      false,
    );
    expect(
      readerLayoutSchema.safeParse({ sidebarOpen: 1, panelOpen: false, headerOpen: true }).success,
    ).toBe(false);
  });

  it("lastHighlightStyle validates against the annotation style enum", () => {
    expect(PREFERENCE_SCHEMAS.lastHighlightStyle.safeParse("yellow").success).toBe(true);
    expect(PREFERENCE_SCHEMAS.lastHighlightStyle.safeParse("teal").success).toBe(false);
  });

  it("setPreferenceInput covers exactly the registered keys (no drift)", () => {
    const unionKeys = setPreferenceInput.options.map((o) => o.shape.key.value).sort();
    expect(unionKeys).toEqual(Object.keys(PREFERENCE_SCHEMAS).sort());
  });

  it("setPreferenceInput validates value per key at the boundary", () => {
    expect(setPreferenceInput.safeParse({ key: "autoSummarize", value: true }).success).toBe(true);
    expect(setPreferenceInput.safeParse({ key: "autoSummarize", value: "yes" }).success).toBe(
      false,
    );
    expect(setPreferenceInput.safeParse({ key: "colorMode", value: "dark" }).success).toBe(true);
    expect(setPreferenceInput.safeParse({ key: "colorMode", value: "sepia" }).success).toBe(false);
    expect(
      setPreferenceInput.safeParse({ key: "readerPrefs", value: { fontScale: 1 } }).success,
    ).toBe(false);
    expect(setPreferenceInput.safeParse({ key: "unknownKey", value: 1 }).success).toBe(false);
    expect(
      setPreferenceInput.safeParse({
        key: "readerLayout",
        value: { sidebarOpen: true, panelOpen: false, headerOpen: true },
      }).success,
    ).toBe(true);
    expect(
      setPreferenceInput.safeParse({ key: "readerLayout", value: { sidebarOpen: true } }).success,
    ).toBe(false);
  });

  it("readerPrefs 旧 JSON(无 fontFamily)parse 成功且默认 default", () => {
    const parsed = readerPrefsSchema.parse({ fontScale: 1, lineHeight: 1.9, maxWidth: 640 });
    expect(parsed.fontFamily).toBe("default");
  });

  it("fontFamily 接受四档枚举、拒绝未知值", () => {
    const base = { fontScale: 1, lineHeight: 1.9, maxWidth: 640 };
    for (const v of ["default", "wenkai", "serif", "sans"]) {
      expect(readerPrefsSchema.safeParse({ ...base, fontFamily: v }).success).toBe(true);
    }
    expect(readerPrefsSchema.safeParse({ ...base, fontFamily: "comic-sans" }).success).toBe(false);
  });
});

describe("language preference", () => {
  it("preferenceKey includes language", () => {
    expect(preferenceKey.options).toContain("language");
  });
  it("setPreferenceInput accepts a valid language, rejects junk", () => {
    expect(setPreferenceInput.safeParse({ key: "language", value: "en" }).success).toBe(true);
    expect(setPreferenceInput.safeParse({ key: "language", value: "zh-CN" }).success).toBe(true);
    expect(setPreferenceInput.safeParse({ key: "language", value: "fr" }).success).toBe(false);
  });
});
