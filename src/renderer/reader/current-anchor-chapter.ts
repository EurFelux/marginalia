export interface AnchorChapterPos {
  id: string;
  anchor: string;
  top: number; // 该锚点元素在 section 内的 offsetTop（px）
}

/** 选「锚点 offsetTop ≤ 视口顶位置」中最靠后的章；都在下方则取第一个（section 刚进顶部）。 */
export function pickAnchorChapterId(
  chapters: AnchorChapterPos[],
  viewportTop: number,
): string | null {
  if (chapters.length === 0) return null;
  let picked = chapters[0]!.id;
  for (const c of chapters) {
    if (c.top <= viewportTop) picked = c.id;
    else break;
  }
  return picked;
}
