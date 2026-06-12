/** TTS 选声用的粗粒度语种（选 voice 只需语种级；spec §4.2）。 */
export type TtsLang = "zh" | "ja" | "en";

/**
 * 段级语种启发式：在字母/数字字符中统计假名与 CJK 表意占比。
 * 假名是强日文信号（日文必含假名、中文不含），低阈值即判 ja；
 * CJK 占比过 30% 判 zh（容忍中文段里嵌英文术语）；其余回退 en。
 */
export function detectParagraphLang(text: string): TtsLang {
  let cjk = 0;
  let kana = 0;
  let total = 0;
  for (const ch of text) {
    if (!/[\p{L}\p{N}]/u.test(ch)) continue;
    total++;
    const cp = ch.codePointAt(0)!;
    if (cp >= 0x3040 && cp <= 0x30ff) kana++;
    else if ((cp >= 0x4e00 && cp <= 0x9fff) || (cp >= 0x3400 && cp <= 0x4dbf)) cjk++;
  }
  if (total === 0) return "en";
  if (kana / total > 0.05) return "ja";
  if (cjk / total > 0.3) return "zh";
  return "en";
}
