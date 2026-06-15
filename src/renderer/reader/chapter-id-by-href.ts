import type { ChapterRefDto } from "@shared/library";

function stripFragment(href: string): string {
  return href.split("#")[0]!.split("?")[0]!;
}

/** 取末段文件名（路径前缀不一致时的兜底匹配）。 */
export function basename(href: string): string {
  const p = stripFragment(href);
  return p.slice(p.lastIndexOf("/") + 1);
}

/**
 * href → 匹配的章列表：先 exact（去 fragment）命中则返回全部 exact；否则返回全部 basename 命中。
 * 同 href 多章（锚点切章）会返回多项，供调用方做 anchor 级细分。
 */
export function chaptersMatchingHref(chapters: ChapterRefDto[], href: string): ChapterRefDto[] {
  const target = stripFragment(href);
  const exact = chapters.filter((c) => stripFragment(c.href) === target);
  if (exact.length > 0) return exact;
  const base = basename(href);
  return chapters.filter((c) => basename(c.href) === base);
}

/** spine 项 href → 唯一章节 id；歧义（多命中）或无命中返回 null。 */
export function chapterIdByHref(chapters: ChapterRefDto[], href: string): string | null {
  const m = chaptersMatchingHref(chapters, href);
  return m.length === 1 ? m[0]!.id : null;
}
