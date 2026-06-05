/** auto naming 进行中查询（下一任务接真状态；先恒 false 占位接通编译）。 */
const namingInFlight = new Set<string>();
export function isNamingConversation(id: string): boolean {
  return namingInFlight.has(id);
}

const MAX_TITLE_LEN = 40;

/**
 * 由首条用户消息派生「随便起」的会话标题：取首个非空行、压缩内部空白、截断到 MAX_TITLE_LEN（超出加省略号）。
 * 全空白返回空串。未来「自动命名会话」功能将覆盖同一 title 字段。
 */
export function deriveConversationTitle(userText: string): string {
  const firstLine =
    userText
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  return [...collapsed].length <= MAX_TITLE_LEN // oxlint-disable-line no-misused-spread
    ? collapsed
    : [...collapsed].slice(0, MAX_TITLE_LEN).join("") + "…"; // oxlint-disable-line no-misused-spread
}
