import type { HighlightColor } from "#/mock/types";

/** 高亮配色（Apple Books 风）：swatch=工具栏色点、mark=正文高亮底色、stripe=列表色条。 */
export const HIGHLIGHT: Record<
  HighlightColor,
  { label: string; swatch: string; mark: string; stripe: string }
> = {
  yellow: {
    label: "黄",
    swatch: "bg-yellow-300",
    mark: "bg-yellow-200/70 dark:bg-yellow-400/25",
    stripe: "bg-yellow-400",
  },
  green: {
    label: "绿",
    swatch: "bg-green-300",
    mark: "bg-green-200/70 dark:bg-green-400/25",
    stripe: "bg-green-400",
  },
  blue: {
    label: "蓝",
    swatch: "bg-sky-300",
    mark: "bg-sky-200/70 dark:bg-sky-400/25",
    stripe: "bg-sky-400",
  },
  pink: {
    label: "粉",
    swatch: "bg-pink-300",
    mark: "bg-pink-200/70 dark:bg-pink-400/25",
    stripe: "bg-pink-400",
  },
  purple: {
    label: "紫",
    swatch: "bg-purple-300",
    mark: "bg-purple-200/70 dark:bg-purple-400/25",
    stripe: "bg-purple-400",
  },
};

export const HIGHLIGHT_COLORS = Object.keys(HIGHLIGHT) as HighlightColor[];
