/**
 * 无封面兜底 tile 的渐变配色调色板。**字面量写死**这些类名供 Tailwind JIT 扫描生成
 * （配合 `bg-gradient-to-br ${coverGradientClass(id)}` 使用）。
 */
export const COVER_GRADIENTS = [
  "from-violet-500 to-violet-900",
  "from-rose-500 to-rose-900",
  "from-emerald-500 to-emerald-900",
  "from-sky-500 to-sky-900",
  "from-amber-500 to-amber-800",
  "from-fuchsia-500 to-fuchsia-900",
  "from-teal-500 to-teal-900",
  "from-indigo-500 to-indigo-900",
] as const;

/** 由 bookId 确定性派生一个调色板项（同书恒定、跨书多彩随机）。 */
export function coverGradientClass(bookId: string): string {
  let h = 0;
  for (let i = 0; i < bookId.length; i++) h = (h * 31 + bookId.charCodeAt(i)) >>> 0;
  return COVER_GRADIENTS[h % COVER_GRADIENTS.length];
}
