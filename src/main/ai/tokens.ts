// src/main/ai/tokens.ts

// 覆盖常见 CJK 区段：标点/符号(3000-303f)、扩展A(3400-4dbf)、统一汉字(4e00-9fff)、
// 兼容汉字(f900-faff)、全角及半角形式(ff00-ffef)。命中即按 ~1 token 估算。
const CJK = /[\u3000-\u303f\u3400-\u4dbf\u4e00-\u9fff\uf900-\ufaff\uff00-\uffef]/;

/**
 * 粗略 token 估算（无 tokenizer 依赖，仅供 chip 信息展示）。
 * CJK 字符计 1、其余字符计 0.25，求和后向上取整（Math.ceil 作用于总和）。后续如需精确再换真 tokenizer。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}
