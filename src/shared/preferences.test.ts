import { describe, expect, it } from "vitest";
import {
  PREFERENCE_SCHEMAS,
  preferenceKey,
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
      "lastHighlightStyle",
      "readerPrefs",
    ]);
  });

  it("preferenceKey accepts known keys and rejects unknown", () => {
    expect(preferenceKey.safeParse("readerPrefs").success).toBe(true);
    expect(preferenceKey.safeParse("autoSummarize").success).toBe(true);
    expect(preferenceKey.safeParse("colorMode").success).toBe(false);
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
    expect(
      setPreferenceInput.safeParse({ key: "readerPrefs", value: { fontScale: 1 } }).success,
    ).toBe(false);
    expect(setPreferenceInput.safeParse({ key: "unknownKey", value: 1 }).success).toBe(false);
  });
});
