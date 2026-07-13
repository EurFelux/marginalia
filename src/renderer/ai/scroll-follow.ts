const BOTTOM_TOLERANCE_PX = 4;

export interface ScrollPosition {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
}

export interface MessageScrollUpdate {
  following: boolean;
  previousLength: number;
  prependedHistory: boolean;
  lastMessageChanged: boolean;
  streamingAssistant: boolean;
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
  previousLength,
  prependedHistory,
  lastMessageChanged,
  streamingAssistant,
}: MessageScrollUpdate): "instant" | null {
  return following &&
    previousLength > 0 &&
    !prependedHistory &&
    (lastMessageChanged || streamingAssistant)
    ? "instant"
    : null;
}
