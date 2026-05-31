// src/main/ai/prompt.ts
import type { ModelMessage, UIMessage } from "ai";
import type { Chip, MessageDto } from "@shared/chat";

export type PromptHistoryMessage = Pick<MessageDto, "role" | "parts" | "metadata">;

export interface AssemblePromptParams {
  systemPrompt: string | null;
  /** 当前章摘要（仅当 ready 时传入；null = 省略）。 */
  chapter: { title: string | null; summary: string } | null;
  /** 既往消息（按 seq 升序）。 */
  history: PromptHistoryMessage[];
  current: { chips: Chip[]; userText: string };
}

function textOfParts(parts: UIMessage["parts"]): string {
  let s = "";
  // 仅保留 text part；MA4 assistant 消息仅含 text，工具/推理 part 待 MA5 处理
  for (const p of parts) if (p.type === "text") s += p.text;
  return s;
}

function chipContent(
  chips: ReadonlyArray<{ id: string; content: string }>,
  id: "selection" | "paragraph",
): string | null {
  return chips.find((c) => c.id === id)?.content ?? null;
}

function renderUserTurn(opts: {
  chapter: { title: string | null; summary: string } | null;
  paragraph: string | null;
  selection: string | null;
  userText: string;
}): string {
  const sections: string[] = [];
  if (opts.chapter) {
    const head = opts.chapter.title ? `## 本章概要：${opts.chapter.title}` : "## 本章概要";
    sections.push(`${head}\n${opts.chapter.summary}`);
  }
  if (opts.paragraph) sections.push(`## 周围上下文\n${opts.paragraph}`);
  if (opts.selection) sections.push(`## 选中文本\n${opts.selection}`);
  const context = sections.join("\n\n");
  return context ? `${context}\n\n${opts.userText}` : opts.userText;
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
    // contextChips 可能不存在（如仅带 usage/model 元数据的历史 user 消息）→ 优雅降级为无上下文
    const chips = h.metadata?.contextChips ?? [];
    out.push({
      role: "user",
      content: renderUserTurn({
        chapter: null,
        paragraph: chipContent(chips, "paragraph"),
        selection: chipContent(chips, "selection"),
        userText: textOfParts(h.parts),
      }),
    });
  }

  out.push({
    role: "user",
    content: renderUserTurn({
      chapter: params.chapter,
      paragraph: chipContent(params.current.chips, "paragraph"),
      selection: chipContent(params.current.chips, "selection"),
      userText: params.current.userText,
    }),
  });

  return out;
}
