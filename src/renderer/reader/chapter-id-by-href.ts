import type { ChapterRefDto } from "@shared/library";

/** 去掉 #fragment 与查询串，得到纯路径。 */
function stripFragment(href: string): string {
  return href.split("#")[0]!.split("?")[0]!;
}

/** 取末段文件名（用于路径前缀不一致时的兜底匹配）。 */
function basename(href: string): string {
  const p = stripFragment(href);
  return p.slice(p.lastIndexOf("/") + 1);
}

/**
 * 把 spine 项 href 映射到章节 id（当前章高亮/进度用）。
 * 先精确匹配（去 fragment），再退到 basename 匹配（epubjs 与 epub-parser 的 href
 * 路径前缀可能不同）。basename 命中多个（多卷书同名文件，如 part1/intro 与 part2/intro）时
 * 视为歧义、返回 null——对「当前章追踪」而言，宁可不高亮也不要错章。都不中也返回 null（可接受边界）。
 */
export function chapterIdByHref(chapters: ChapterRefDto[], href: string): string | null {
  const target = stripFragment(href);
  const exact = chapters.find((c) => stripFragment(c.href) === target);
  if (exact) return exact.id;
  const base = basename(href);
  const byBase = chapters.filter((c) => basename(c.href) === base);
  return byBase.length === 1 ? byBase[0]!.id : null;
}
