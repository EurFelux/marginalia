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
 * PDF 高亮 overlay 矩形样式（主文档 Tailwind 生效；半透明色块叠在 canvas 上、
 * textLayer 之下）。underline 不填充、画底边线。暗色下 canvas 反色但 overlay
 * 不反（在 canvas 元素之外），45% 透明度两种模式均可读。
 */
export const OVERLAY_FILL: Record<AnnotationStyle, string> = {
  yellow: "bg-yellow-300/45",
  green: "bg-green-300/45",
  blue: "bg-sky-300/45",
  pink: "bg-pink-300/45",
  purple: "bg-purple-300/45",
  underline: "border-b-2 border-foreground/60",
};

/**
 * 「有笔记」判定：ePub 的 `.anno-noted`（apply-annotations.ts）与 PDF overlay 的
 * 点状底边（overlayClass）共用此谓词——语义改这里一处。
 */
export function hasNote(note: string): boolean {
  return note.trim().length > 0;
}

/**
 * PDF overlay 矩形类（含笔记记号）：有笔记 → 底边点状线，与 ePub `.anno-noted`
 * 的 dotted text-decoration 同一约定（见下 ANNO_IFRAME_CSS——改一侧必改另一侧）；
 * underline 样式则把实线底边换成点状（不叠两条线，沿用其原 /60 浓度）；填充色上的
 * 点状线用更深的 /70 以在色块上保持对比。border-foreground 明暗自适应。
 */
export function overlayClass(style: AnnotationStyle, noted: boolean): string {
  if (!noted) return OVERLAY_FILL[style];
  if (style === "underline") return "border-b-2 border-dotted border-foreground/60";
  return `${OVERLAY_FILL[style]} border-b-2 border-dotted border-foreground/70`;
}

/**
 * 注入每个 section iframe 的高亮 CSS（iframe 是 sandboxed srcdoc，主应用 Tailwind 不生效，
 * 故用具体 CSS）。`.anno` 可点击；5 色背景填充；underline 走 text-decoration；
 * `.anno-noted` 叠虚线下划表示有笔记（与 PDF 侧 overlayClass 同一约定，改一侧必改另一侧）。
 */
export const ANNO_IFRAME_CSS = [
  "mark.anno { background: transparent; cursor: pointer; }",
  "mark.anno-yellow { background: rgba(254,240,138,0.7); }",
  "mark.anno-green { background: rgba(187,247,208,0.7); }",
  "mark.anno-blue { background: rgba(186,230,253,0.7); }",
  "mark.anno-pink { background: rgba(251,207,232,0.7); }",
  "mark.anno-purple { background: rgba(233,213,255,0.7); }",
  "mark.anno-underline { background: transparent; text-decoration: underline; text-decoration-color: rgba(120,120,120,0.9); text-decoration-thickness: 2px; }",
  // 用 longhand 而非 text-decoration 简写：简写会把 .anno-underline 设的 color/thickness 重置掉。
  // 显式 line:underline 让色块填充类（无下划线）也能显示「有笔记」的虚线提示，
  // 同时让下划线类的灰色/2px 经 cascade 保留。
  "mark.anno-noted { text-decoration-line: underline; text-decoration-style: dotted; text-underline-offset: 3px; }",
].join("\n");
