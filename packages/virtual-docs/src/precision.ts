/** 估高占位：缓存命中用缓存高度，否则用默认估值。 */
export function estimateHeight(
  cache: ReadonlyMap<number, number>,
  index: number,
  defaultEstimate: number,
): number {
  return cache.get(index) ?? defaultEstimate;
}

/**
 * 距 active range 超过 keepDistance 的 section 索引（应 unload 的集合）。
 * 保留区间 = [startIndex - keepDistance, endIndex + keepDistance]，区间外全部淘汰。
 */
export function sectionsToUnload(
  range: { startIndex: number; endIndex: number },
  total: number,
  keepDistance: number,
): number[] {
  const lo = range.startIndex - keepDistance;
  const hi = range.endIndex + keepDistance;
  const out: number[] = [];
  for (let i = 0; i < total; i++) {
    if (i < lo || i > hi) out.push(i);
  }
  return out;
}

/**
 * 给定各 section 在视口坐标的 top/bottom 与视口顶线 viewportTop，挑真实视口顶 section 的索引。
 * 规则：① 优先选「跨越视口顶线」者（top<=vt<bottom；多个取 top 最大、最贴线下方）；
 *       ② 间隙无命中时取 top>=vt 中 top 最小者（视口下方最近）；
 *       ③ 全在上方时取 bottom 最大者（最靠下）。空输入返回 null。
 */
export function topVisibleIndex(
  sections: ReadonlyArray<{ index: number; top: number; bottom: number }>,
  viewportTop: number,
): number | null {
  if (sections.length === 0) return null;
  const crossing = sections.filter((s) => s.top <= viewportTop && s.bottom > viewportTop);
  if (crossing.length > 0) {
    return crossing.reduce((a, b) => (b.top > a.top ? b : a)).index;
  }
  const below = sections.filter((s) => s.top >= viewportTop);
  if (below.length > 0) {
    return below.reduce((a, b) => (b.top < a.top ? b : a)).index;
  }
  return sections.reduce((a, b) => (b.bottom > a.bottom ? b : a)).index;
}

export function topVisibleSection(
  sections: ReadonlyArray<{ index: number; top: number; bottom: number }>,
  viewportTop: number,
): { index: number; top: number; bottom: number } | null {
  const index = topVisibleIndex(sections, viewportTop);
  return index == null ? null : (sections.find((s) => s.index === index) ?? null);
}

export function sectionScrollRatio(
  section: { top: number; bottom: number },
  viewportTop: number,
): number {
  const height = Math.max(1, section.bottom - section.top);
  return Math.min(1, Math.max(0, (viewportTop - section.top) / height));
}
