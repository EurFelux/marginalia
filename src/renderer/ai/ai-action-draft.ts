export type PresetId = "explain" | "translate" | "summarize";

/**
 * AI 动作触发时对 Composer 草稿文本的处置（纯决策，无 i18n 依赖，故可无头单测）：
 * - 有 preset（解释/翻译/概括）→ 用预设提示语**覆盖**草稿；
 * - 无 preset（「AI 问」）→ 返回 `null`，表示**保留**用户已输入的文字（不清空）。
 *
 * @param resolvePrompt 注入的预设提示语解析器（依赖 i18n，留在调用方 hook 里）。
 */
export function presetDraftText(
  preset: PresetId | null,
  resolvePrompt: (preset: PresetId) => string,
): string | null {
  return preset ? resolvePrompt(preset) : null;
}
