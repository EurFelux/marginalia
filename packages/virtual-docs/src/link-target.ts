export type LinkTarget =
  | { type: "external"; url: string }
  | { type: "internal"; href: string }
  | null;

const EXTERNAL = /^(https?:|mailto:)/i;

/** 把 iframe 内 <a href> 分类：绝对 http/https/mailto = 外链；其余（相对路径 / #fragment）= 站内；空/裸"#" = 忽略。 */
export function classifyLink(href: string): LinkTarget {
  const h = href.trim();
  if (!h || h === "#") return null;
  if (EXTERNAL.test(h)) return { type: "external", url: h };
  return { type: "internal", href: h };
}
