/** 估高占位：缓存命中用缓存高度，否则用默认估值。 */
export function estimateHeight(
  cache: ReadonlyMap<number, number>,
  index: number,
  defaultEstimate: number,
): number {
  return cache.get(index) ?? defaultEstimate;
}

/**
 * 带校准的估高：缓存命中直接用；未测量时用「已测 section 的 px/权重比」乘以目标权重外推
 * （权重 = 消费方提供的相对体量，如章节字符数）。无权重函数 / 无有效样本 / 目标权重为 0
 * 时退回 defaultEstimate。校准样本须排除权重 0 的 section（封面图等会污染比率）。
 */
export function calibratedEstimate(
  cache: ReadonlyMap<number, number>,
  weightOf: ((index: number) => number) | undefined,
  index: number,
  defaultEstimate: number,
): number {
  const cached = cache.get(index);
  if (cached != null) return cached;
  if (!weightOf) return defaultEstimate;
  const targetWeight = weightOf(index);
  if (targetWeight <= 0) return defaultEstimate;
  let sumHeight = 0;
  let sumWeight = 0;
  for (const [i, h] of cache) {
    const w = weightOf(i);
    if (w <= 0) continue;
    sumHeight += h;
    sumWeight += w;
  }
  if (sumWeight <= 0) return defaultEstimate;
  return targetWeight * (sumHeight / sumWeight);
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
