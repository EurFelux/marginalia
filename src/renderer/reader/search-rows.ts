import type { BookSearchHit } from "@shared/search";

/** 虚拟列表的一行：分组标题或一条命中。 */
export type SearchRow =
  | { kind: "group"; key: string; hit: BookSearchHit }
  | { kind: "hit"; key: string; index: number; hit: BookSearchHit };

/** 连续命中按章节分组（PDF 无章节时按页）。 */
function groupKey(hit: BookSearchHit): string {
  if (hit.chapterId) return `ch:${hit.chapterId}`;
  return hit.target.format === "pdf" ? `page:${hit.target.page}` : "none";
}

/** 命中列表 → 带分组标题的扁平行；rowOfHit[i] 为第 i 条命中所在行（供滚动到当前命中）。 */
export function searchRows(hits: BookSearchHit[]): { rows: SearchRow[]; rowOfHit: number[] } {
  const rows: SearchRow[] = [];
  const rowOfHit: number[] = [];
  hits.forEach((hit, index) => {
    const group = groupKey(hit);
    if (index === 0 || groupKey(hits[index - 1]!) !== group) {
      rows.push({ kind: "group", key: `g${index}:${group}`, hit });
    }
    rowOfHit.push(rows.length);
    rows.push({ kind: "hit", key: `h${index}`, index, hit });
  });
  return { rows, rowOfHit };
}
