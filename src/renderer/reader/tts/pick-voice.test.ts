import { describe, expect, it } from "vitest";
import { NOVELTY_BLOCKLIST, pickVoice } from "./pick-voice";

/** 测试用 voice 形状（SpeechSynthesisVoice 只读且无构造器，用结构兼容对象代替）。 */
function v(name: string, lang: string, opts?: { localService?: boolean; default?: boolean }) {
  return {
    name,
    lang,
    localService: opts?.localService ?? true,
    default: opts?.default ?? false,
    voiceURI: name,
  } as SpeechSynthesisVoice;
}

const MAC_VOICES = [
  v("Albert", "en-US"),
  v("Samantha", "en-US"),
  v("Alex", "en-US"),
  v("Tingting", "zh-CN"),
  v("Kyoko", "ja-JP"),
];

describe("pickVoice", () => {
  it("user preference wins over recommendations", () => {
    const got = pickVoice("en", MAC_VOICES, { voiceByLang: { en: "Alex" } }, "macos");
    expect(got?.name).toBe("Alex");
  });
  it("stale preference falls through to recommended", () => {
    const got = pickVoice("en", MAC_VOICES, { voiceByLang: { en: "Ghost" } }, "macos");
    expect(got?.name).toBe("Samantha");
  });
  it("macOS recommended order is honored", () => {
    expect(pickVoice("en", MAC_VOICES, { voiceByLang: {} }, "macos")?.name).toBe("Samantha");
    expect(pickVoice("zh", MAC_VOICES, { voiceByLang: {} }, "macos")?.name).toBe("Tingting");
  });
  it("generic fallback skips novelty voices", () => {
    const voices = [v("Albert", "en-US"), v("Whisper", "en-US"), v("Plain", "en-GB")];
    expect(pickVoice("en", voices, { voiceByLang: {} }, "macos")?.name).toBe("Plain");
  });
  it("generic fallback prefers localService + default", () => {
    const voices = [
      v("Remote", "en-US", { localService: false }),
      v("LocalDefault", "en-US", { localService: true, default: true }),
      v("LocalPlain", "en-US", { localService: true }),
    ];
    expect(pickVoice("en", voices, { voiceByLang: {} }, "windows")?.name).toBe("LocalDefault");
  });
  it("returns null when no voice matches the lang", () => {
    expect(pickVoice("ja", [v("Samantha", "en-US")], { voiceByLang: {} }, "macos")).toBeNull();
  });
  it("blocklist contains known macOS novelty voices", () => {
    expect(NOVELTY_BLOCKLIST).toContain("Albert");
    expect(NOVELTY_BLOCKLIST).toContain("Bad News");
  });
});
