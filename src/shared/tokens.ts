// src/shared/tokens.ts

// 覆盖常见 CJK 区段：标点/符号(3000-303f)、扩展A(3400-4dbf)、统一汉字(4e00-9fff)、
// 兼容汉字(f900-faff)、全角及半角形式(ff00-ffef)。命中即按 ~1 token 估算。
const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;

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

export interface TokenBudgetSlice {
  text: string;
  tokens: number;
  truncated: boolean;
}

/**
 * 按 estimateTokens 的口径把文本截到 token 预算内：返回估算不超过 budget 的最长前缀。
 * 用于「按 token 记账、按字符截断」的证据分页——直接按字符设预算会让同一数字在 CJK 与
 * 拉丁文本下相差约 4 倍（CJK 1 字符 ≈ 1 token，其余 4 字符 ≈ 1 token）。
 * budget ≤ 0 时返回空串并标记截断（除非原文本身为空）。
 */
export function sliceToTokenBudget(text: string, budget: number): TokenBudgetSlice {
  const total = estimateTokens(text);
  if (total <= budget) return { text, tokens: total, truncated: false };
  let weight = 0;
  let end = 0;
  for (const ch of text) {
    const next = weight + (CJK.test(ch) ? 1 : 0.25);
    if (Math.ceil(next) > budget) break;
    weight = next;
    end += ch.length;
  }
  return { text: text.slice(0, end), tokens: Math.ceil(weight), truncated: true };
}
