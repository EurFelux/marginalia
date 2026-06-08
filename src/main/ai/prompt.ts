// src/main/ai/prompt.ts
import type { ModelMessage, UIMessage } from "ai";
import type { Chip, MessageDto, ReadingContext } from "@shared/chat";

export type PromptHistoryMessage = Pick<MessageDto, "role" | "parts" | "metadata">;

export interface AssemblePromptParams {
  systemPrompt: string | null;
  /** 既往消息（按 seq 升序）。 */
  history: PromptHistoryMessage[];
  /** 滚动概要（已折叠的早期轮）；非空时拼入 system。null = 无概要。 */
  priorSummary?: string | null;
  current: { chips: Chip[]; userText: string; readingContext?: ReadingContext | null };
}

/** 仅保留 text part（assistant 的 tool-call/reasoning part 有意不回放，Phase 1 选择）。 */
export function textOfParts(parts: UIMessage["parts"]): string {
  let s = "";
  for (const p of parts) if (p.type === "text") s += p.text;
  return s;
}

type ChipLike = ReadonlyArray<{ id: string; content: string }>;

function chipContent(chips: ChipLike, id: Chip["id"]): string | null {
  return chips.find((c) => c.id === id)?.content ?? null;
}

/**
 * 单条 user 轮渲染：上下文全部来自该轮的 chips（历史轮取 metadata.contextChips 快照、
 * 当前轮取 live chips）——历史与当前完全同构，无隐藏注入通道（spec §5/§6）。
 * 固定 section 顺序：全书概要 → 本章概要 → 周围上下文 → 选中文本。
 */
function renderUserTurn(chips: ChipLike, userText: string): string {
  const sections: string[] = [];
  const bookSummary = chipContent(chips, "book-summary");
  if (bookSummary) sections.push(`## 全书概要\n${bookSummary}`);
  const chapterSummary = chipContent(chips, "chapter-summary");
  if (chapterSummary) sections.push(`## 本章概要\n${chapterSummary}`);
  const paragraph = chipContent(chips, "paragraph");
  if (paragraph) sections.push(`## 周围上下文\n${paragraph}`);
  const selection = chipContent(chips, "selection");
  if (selection) sections.push(`## 选中文本\n${selection}`);
  const context = sections.join("\n\n");
  return context ? `${context}\n\n${userText}` : userText;
}

/**
 * 把单条历史消息渲染成喂模型的纯文本：assistant 取 text part（reasoning/tool part 不回放），
 * user 轮带其 chips。assemblePrompt 与上下文压缩共用此单一渲染口径。
 */
export function renderHistoryMessage(h: PromptHistoryMessage): string {
  return h.role === "assistant"
    ? textOfParts(h.parts)
    : renderUserTurn(h.metadata?.contextChips ?? [], textOfParts(h.parts));
}

function renderReadingContext(ctx: ReadingContext | null | undefined): string | null {
  if (!ctx) return null;
  if (ctx.format === "pdf") {
    const chapter = ctx.chapterTitle ? `, current chapter: ${ctx.chapterTitle}` : "";
    const pageCount = ctx.pageCount != null ? ` of ${ctx.pageCount}` : "";
    return (
      `## Current reading position\nPDF page ${ctx.page}${pageCount}${chapter}.\n` +
      `To read the user's current page verbatim, call readPage with {"page":${ctx.page},"mode":"text"}.`
    );
  }
  const title = ctx.chapterTitle ? ` (${ctx.chapterTitle})` : "";
  const offset = ctx.offset ?? 0;
  const maxChars = ctx.maxChars ?? 4000;
  return (
    `## Current reading position\nePub chapterId: ${ctx.chapterId}${title}.\n` +
    `Estimated chapter text offset: ${offset}.\n` +
    `To read from the user's current ePub location without loading the whole chapter, call readChapterText with {"chapterId":"${ctx.chapterId}","offset":${offset},"maxChars":${maxChars}}.`
  );
}

/** PDF 会话的 system prompt 附注（spec §7）：让模型知道页粒度工具的存在与扫描版的现实。 */
export function pdfSystemNote(p: {
  pageCount: number | null;
  hasTextLayer: boolean;
  imageMode: boolean;
}): string {
  const pages = p.pageCount != null ? ` with ${p.pageCount} pages` : "";
  const lines = [`The current book is a PDF${pages}.`];
  if (p.hasTextLayer) {
    lines.push(
      "Chapter text contains [p.N] page-boundary markers; use the readPage tool to read a specific page by number.",
    );
  } else {
    lines.push(
      "This PDF is scanned and has no text layer, so chapter text extraction is unavailable.",
    );
  }
  if (p.imageMode) {
    lines.push(
      'readPage mode "image" renders a page visually — use it for figures, tables, or scanned pages.',
    );
  }
  return lines.join(" ");
}

/** 组装分层上下文为 ModelMessage[]（设计文档 §10）。纯函数，无模型调用。 */
export function assemblePrompt(params: AssemblePromptParams): ModelMessage[] {
  const out: ModelMessage[] = [];

  const summary = params.priorSummary?.trim() ? params.priorSummary.trim() : null;
  const sysParts: string[] = [];
  if (params.systemPrompt) sysParts.push(params.systemPrompt);
  if (summary) sysParts.push(`## Conversation summary so far\n${summary}`);
  if (sysParts.length > 0) out.push({ role: "system", content: sysParts.join("\n\n") });

  for (const h of params.history) {
    // 历史里的 system 消息丢弃：系统提示词由当前 Assistant 重新注入，避免重复/冲突
    if (h.role === "system") continue;
    if (h.role === "assistant") {
      out.push({ role: "assistant", content: renderHistoryMessage(h) });
      continue;
    }
    out.push({ role: "user", content: renderHistoryMessage(h) });
  }

  // Reading position is intentionally injected only into the live/current user turn:
  // it changes on scroll, so putting it in system/history would churn prompt-cache prefixes.
  // It is also not persisted in message metadata; future turns get their own fresh position.
  out.push({
    role: "user",
    content: [
      renderReadingContext(params.current.readingContext),
      renderUserTurn(params.current.chips, params.current.userText),
    ]
      .filter((s): s is string => Boolean(s))
      .join("\n\n"),
  });

  return out;
}
