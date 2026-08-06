const BOTTOM_TOLERANCE_PX = 4;

export interface ScrollPosition {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export interface MessageScrollUpdate {
  following: boolean;
  openingConversation: boolean;
  previousLength: number;
  prependedHistory: boolean;
  lastMessageChanged: boolean;
  streamingAssistant: boolean;
}

/**
 * 打开会话后一次性定位到底部的滚动方式。
 *
 * 必须是 instant：smooth 分帧滚动，途中每帧都派发 scroll 事件，而起始几帧的 scrollTop 仍落在
 * 无限列表的「接近顶部」阈值内 → 误触发上翻加载一页；该加载完成后的锚点恢复又直接写 scrollTop，
 * 把滚动动画取消在半途 → 首屏永远停不到底部。一次到位不产生中间帧，两个症状一并消失。
 */
export function conversationOpenScrollBehavior(): "instant" {
  return "instant";
}

export function isScrollAtBottom({
  scrollHeight,
  scrollTop,
  clientHeight,
}: ScrollPosition): boolean {
  return scrollHeight - scrollTop - clientHeight <= BOTTOM_TOLERANCE_PX;
}

export function messageScrollBehavior({
  following,
  openingConversation,
  previousLength,
  prependedHistory,
  lastMessageChanged,
  streamingAssistant,
}: MessageScrollUpdate): "instant" | null {
  return following &&
    !openingConversation &&
    previousLength > 0 &&
    !prependedHistory &&
    (lastMessageChanged || streamingAssistant)
    ? "instant"
    : null;
}
