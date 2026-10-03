/**
 * 导入候选的前端搜索：按空白拆成若干关键词，每个都要出现在名称或描述里（不区分大小写）。
 * 空查询返回原列表。
 */
export function filterSkills<T extends { name: string; description: string }>(
  items: readonly T[],
  query: string,
): T[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [...items];
  return items.filter((item) => {
    const haystack = `${item.name}\n${item.description}`.toLowerCase();
    return terms.every((term) => haystack.includes(term));
  });
}
