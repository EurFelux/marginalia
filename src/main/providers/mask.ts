/**
 * 把 API key 明文转为可安全展示的掩码预览，例如 "sk-…1234"。
 * - 长度 ≤ 8：整体打码，不泄露任何字符（"••••"）。
 * - 否则：前缀（前 3 字符）+ "…" + 末 4 字符。
 */
export function maskKey(plaintext: string): string {
  if (plaintext.length <= 8) return "••••";
  return `${plaintext.slice(0, 3)}…${plaintext.slice(-4)}`;
}
