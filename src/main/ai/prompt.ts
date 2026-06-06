// src/main/ai/prompt.ts
import type { ModelMessage, UIMessage } from "ai";
import type { Chip, MessageDto } from "@shared/chat";

export type PromptHistoryMessage = Pick<MessageDto, "role" | "parts" | "metadata">;

export interface AssemblePromptParams {
  systemPrompt: string | null;
  /** 既往消息（按 seq 升序）。 */
  history: PromptHistoryMessage[];
  current: { chips: Chip[]; userText: string };
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

  if (params.systemPrompt) out.push({ role: "system", content: params.systemPrompt });

  for (const h of params.history) {
    // 历史里的 system 消息丢弃：系统提示词由当前 Assistant 重新注入，避免重复/冲突
    if (h.role === "system") continue;
    if (h.role === "assistant") {
      out.push({ role: "assistant", content: textOfParts(h.parts) });
      continue;
    }
    out.push({
      role: "user",
      content: renderUserTurn(h.metadata?.contextChips ?? [], textOfParts(h.parts)),
    });
  }

  out.push({
    role: "user",
    content: renderUserTurn(params.current.chips, params.current.userText),
  });

  return out;
}
