// 互链解析（spec 2026-06-10 §2.1.1）：body 内 [[slug]] 是真相源，边表仅派生。
// slug 形状与 shared/memory.ts 的 memorySlug 一致：英文 kebab-case。
const LINK_RE = /\[\[([a-z0-9]+(?:-[a-z0-9]+)*)\]\]/g;

/** 解析 body 中的 [[slug]]，按出现序去重。非法形状（大写/下划线/空白）不命中。 */
export function extractLinks(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(LINK_RE)) {
    seen.add(m[1]);
  }
  return [...seen];
}
