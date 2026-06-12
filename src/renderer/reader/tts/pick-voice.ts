import type { TtsLang } from "./detect-lang";

export type TtsPlatform = "macos" | "windows" | "linux";

/** macOS novelty voices（音效声，朴素 lang 匹配会踩中；spike 实测）。 */
export const NOVELTY_BLOCKLIST: readonly string[] = [
  "Albert",
  "Bad News",
  "Bahh",
  "Bells",
  "Boing",
  "Bubbles",
  "Cellos",
  "Good News",
  "Jester",
  "Organ",
  "Superstar",
  "Trinoids",
  "Whisper",
  "Wobble",
  "Zarvox",
];

/**
 * 平台分层推荐表（spec §5）：有序候选名单，顺位降级。macOS 实测精选；
 * Windows/Linux 留空走通用兜底（lang 匹配 + localService/default 优先）——
 * 结构上为未来实测补名单留位。
 */
export const RECOMMENDED_VOICES: Record<TtsPlatform, Partial<Record<TtsLang, string[]>>> = {
  macos: {
    en: ["Samantha", "Alex", "Karen", "Daniel"],
    zh: ["Tingting", "Meijia", "Sinji"],
    ja: ["Kyoko"],
  },
  windows: {},
  linux: {},
};

const LANG_PREFIX: Record<TtsLang, string> = { zh: "zh", ja: "ja", en: "en" };

export interface VoicePrefsLike {
  voiceByLang: Record<string, string>;
}

/**
 * 选声降级链（spec §4.2）：用户偏好 → 平台推荐表顺位 → 通用兜底
 * （novelty 过滤 + localService 优先 + default 优先）→ null（引擎默认行为）。
 */
export function pickVoice(
  lang: TtsLang,
  voices: SpeechSynthesisVoice[],
  prefs: VoicePrefsLike,
  platform: TtsPlatform,
): SpeechSynthesisVoice | null {
  const matches = voices.filter((v) => v.lang.toLowerCase().startsWith(LANG_PREFIX[lang]));
  const wanted = prefs.voiceByLang[lang];
  if (wanted) {
    const hit = matches.find((v) => v.name === wanted) ?? voices.find((v) => v.name === wanted);
    if (hit) return hit;
  }
  for (const name of RECOMMENDED_VOICES[platform][lang] ?? []) {
    const hit = matches.find((v) => v.name === name);
    if (hit) return hit;
  }
  const usable = matches.filter((v) => !NOVELTY_BLOCKLIST.includes(v.name));
  return (
    usable.find((v) => v.localService && v.default) ??
    usable.find((v) => v.localService) ??
    usable.find((v) => v.default) ??
    usable[0] ??
    null
  );
}
