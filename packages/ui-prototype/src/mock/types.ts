// 原型本地类型（不镜像 shared/ 或 AI SDK；仅供 UI 原型用）。

export type SummaryStatus = "pending" | "generating" | "ready" | "unavailable";

/** 浮动工具栏上的预设 AI 动作（「AI 问」= null，无模板）。 */
export type PresetId = "explain" | "translate" | "summarize";

export interface TocNode {
  id: string;
  label: string;
  chapterId: string;
  children?: TocNode[];
}

export interface Chapter {
  id: string;
  title: string;
  paragraphs: string[];
  summaryStatus: SummaryStatus;
  /** 章节摘要正文（status=ready 时展示）。 */
  summary: string;
}

export interface Book {
  id: string;
  title: string;
  author: string;
  chapters: Chapter[];
  toc: TocNode[];
  /** 全书 / global 摘要正文（2026-06-01 纳入 Phase 1）。 */
  summary: string;
  summaryStatus: SummaryStatus;
}

/** 渲染层选区提取的产物（原型在静态正文上用浏览器原生选区还原）。 */
export interface SelectionInfo {
  selectionText: string;
  paragraphText: string;
  /** 选区触及的章节（按文档序去重）；length>1 = 跨章选择。 */
  chapterIds: string[];
  /** 划词结束时指针在视口中的坐标（用于浮动工具栏定位，贴合指针）。 */
  anchor: { x: number; y: number };
  /** 选区按段拆出的字符区间（用于落标注、渲染高亮）。 */
  ranges: AnnoRange[];
}

// ——— 标注 / 笔记（Apple Books 式高亮 + 便签）———

export type HighlightColor = "yellow" | "green" | "blue" | "pink" | "purple";

/** 标注在单个段落内的字符区间（按段落字符串下标）。 */
export interface AnnoRange {
  chapterId: string;
  /** 段落在本章 paragraphs 中的下标。 */
  paragraphIndex: number;
  start: number;
  end: number;
}

export interface Annotation {
  id: string;
  color: HighlightColor;
  /** 笔记正文；"" = 仅高亮无笔记。 */
  note: string;
  /** 高亮原文（用于标注列表展示）。 */
  text: string;
  /** 起始章（用于列表分组）。 */
  chapterId: string;
  /** 跨段时一条标注含多段区间。 */
  ranges: AnnoRange[];
  createdAt: number;
}

export type ChipId = "selection" | "paragraph";

export interface Chip {
  id: ChipId;
  labelKey: string;
  content: string;
  tokenCount: number;
  required: boolean;
  enabled: boolean;
}

export interface ToolStep {
  id: string;
  label: string;
  detail: string;
  status: "running" | "done";
}

export type ChatMessage =
  | { id: string; role: "user"; text: string; chips: Chip[] }
  | {
      id: string;
      role: "assistant";
      steps: ToolStep[];
      text: string;
      status: "streaming" | "done" | "error";
    };

/** 侧栏会话列表项（原型仅作视觉演示）。 */
export interface ConversationMeta {
  id: string;
  title: string;
  chapterId: string | null; // null = 独立会话（跨章）
}

export interface ReaderPrefs {
  /** 正文字号缩放（1 = 基准）。 */
  fontScale: number;
  lineHeight: number;
  /** 正文列最大宽度（px）。 */
  maxWidth: number;
}
