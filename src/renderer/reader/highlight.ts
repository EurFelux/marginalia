import type { AnnotationStyle } from "@shared/annotations";

/** 5 个填充色键（下划线单独处理，不在色点里）。 */
export const FILL_COLORS = ["yellow", "green", "blue", "pink", "purple"] as const;
export type FillColor = (typeof FILL_COLORS)[number];

/** 主文档内（Tailwind 生效）：工具栏色点 swatch + 侧栏列表色条 stripe。 */
export const FILL_SWATCH: Record<FillColor, string> = {
  yellow: "bg-yellow-300",
  green: "bg-green-300",
  blue: "bg-sky-300",
  pink: "bg-pink-300",
  purple: "bg-purple-300",
};

export const STYLE_STRIPE: Record<AnnotationStyle, string> = {
  yellow: "bg-yellow-400",
  green: "bg-green-400",
  blue: "bg-sky-400",
  pink: "bg-pink-400",
  purple: "bg-purple-400",
  underline: "bg-foreground/40",
};

/**
 * 注入每个 section iframe 的高亮 CSS（iframe 是 sandboxed srcdoc，主应用 Tailwind 不生效，
 * 故用具体 CSS）。`.anno` 可点击；5 色背景填充；underline 走 text-decoration；
 * `.anno-noted` 叠虚线下划表示有笔记。
 */
export const ANNO_IFRAME_CSS = [
  "mark.anno { background: transparent; cursor: pointer; }",
  "mark.anno-yellow { background: rgba(254,240,138,0.7); }",
  "mark.anno-green { background: rgba(187,247,208,0.7); }",
  "mark.anno-blue { background: rgba(186,230,253,0.7); }",
  "mark.anno-pink { background: rgba(251,207,232,0.7); }",
  "mark.anno-purple { background: rgba(233,213,255,0.7); }",
  "mark.anno-underline { background: transparent; text-decoration: underline; text-decoration-color: rgba(120,120,120,0.9); text-decoration-thickness: 2px; }",
  "mark.anno-noted { text-decoration: underline dotted; text-underline-offset: 3px; }",
].join("\n");
