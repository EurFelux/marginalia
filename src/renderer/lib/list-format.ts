/**
 * 按界面语言把若干项连成一句（「A 和 B」「A, B, and C」）。
 * 中文的连接词（和）两边不带空格，接在路径、代码这类西文片段旁会挤成一团，这里补上空格。
 */
export function formatList(items: readonly string[], language: string): string {
  return new Intl.ListFormat(language, { type: "conjunction" })
    .formatToParts(items)
    .map((part) =>
      part.type === "literal" && /^[一-鿿]+$/.test(part.value) ? ` ${part.value} ` : part.value,
    )
    .join("");
}
