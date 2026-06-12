/** 单 utterance 字符上限：超长 utterance 在部分引擎截断/卡死（spec §4.3/§8 防御）。 */
export const MAX_UTTERANCE_CHARS = 300;

/**
 * 把超长段切成 ≤max 的 utterance 块：句边界（Intl.Segmenter）贪心聚合；
 * 单句仍超长再按逗号/分号/顿号细切（保留分隔符在前块尾，朗读停顿自然）。
 * 拼接结果与原文一致（不丢字），对用户透明（spec §4.3：同段共享 voice 与高亮）。
 */
export function splitForUtterance(text: string, max = MAX_UTTERANCE_CHARS): string[] {
  if (text.length <= max) return [text];
  const seg = new Intl.Segmenter(undefined, { granularity: "sentence" });
  const sentences = [...seg.segment(text)].map((s) => s.segment);
  const out: string[] = [];
  let buf = "";
  const flush = () => {
    if (buf.trim()) out.push(buf);
    buf = "";
  };
  for (const s of sentences) {
    if (s.length > max) {
      flush();
      for (const piece of s.split(/(?<=[,;，；、])/)) {
        if (piece.length > max) {
          // 无标点超长片段：字符级硬切兜底（引擎截断防御不可绕过）
          flush();
          for (let i = 0; i < piece.length; i += max) out.push(piece.slice(i, i + max));
          continue;
        }
        if (buf.length + piece.length > max) flush();
        buf += piece;
      }
      flush();
      continue;
    }
    if (buf.length + s.length > max) flush();
    buf += s;
  }
  flush();
  return out.length ? out : [text];
}
