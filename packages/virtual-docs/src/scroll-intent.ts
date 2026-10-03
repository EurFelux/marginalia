/**
 * 这次用户输入是否意在向上（往回）滚动。只认得出方向的输入：滚轮看 deltaY，按键看往回翻的键；
 * 触摸起点等看不出方向的一律 false。
 *
 * 按 `event.type` 判别而不用 instanceof：iframe 内的事件来自另一个 realm，instanceof 恒为 false。
 */
export function isUpwardScrollIntent(event: Event): boolean {
  if (event.type === "wheel") return (event as WheelEvent).deltaY < 0;
  if (event.type === "keydown") {
    const { key, shiftKey } = event as KeyboardEvent;
    return key === "ArrowUp" || key === "PageUp" || key === "Home" || (key === " " && shiftKey);
  }
  return false;
}
