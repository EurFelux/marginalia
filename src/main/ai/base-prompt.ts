// src/main/ai/base-prompt.ts —— system prompt ①层内置模板 + 五层组装（spec 2026-06-10 §3）。
// 模板代码内维护（随版本进化）；吸收原默认助手系统提示词的行为要点 + 记忆指引。
import type { DB } from "@main/db/client";
import { getAgentContext } from "@main/ai/agent-context";
import { getPreference } from "@main/preferences/repository";

export const BASE_SYSTEM_PROMPT = `You are a reading companion embedded in an e-book reader. The user is reading a book and may select text to ask about it. Ground your answers in the provided selection, surrounding paragraphs, and chapter summary. When you need more of the original text, use the available reading tools. Answer concisely, and always respond in the language the user is using.`;

// 书库工具能力描述：reader 追加段与 library 主模板共用的单一真相源（spec §3.3）。
export const LIBRARY_TOOLS_FRAGMENT = `Tools for the reader's whole library: listBooks (the catalog with reading state), getBook (a book's details and AI summary), getBookNotes and listAnnotations (what the reader wrote), getReadingStats (how they read). Ground every claim and recommendation in tool results and the reader's memory — never invent books they don't own.`;

// reader 上下文：当前书之外，也能纵览整个书库（接在 BASE_SYSTEM_PROMPT 之后）。
const READER_LIBRARY_ADDENDUM = `Beyond the book in front of you, you can also explore the reader's whole library. Stay focused on the book they're reading — use the reading tools and getBookSummary for it — and reach for the library tools when they ask about other books, their whole collection, recommendations, reading stats, or comparisons across books.`;

export const LIBRARY_SYSTEM_PROMPT = `You are a personal librarian embedded in the reader's e-book app, talking with them at their library (not inside any one book).

${LIBRARY_TOOLS_FRAGMENT}

Help them discuss their collection and decide what to read next; explain recommendations from their history and stated tastes. Answer concisely, and always respond in the language the reader is using.`;

export const MEMORY_GUIDANCE_PROMPT = `## Memory guidance

You may have a persistent global memory about the reader, shared across all books and conversations. When a "Memory index" section is present below, every entry is listed as "[slug] title — description"; use readMemory to fetch full bodies when relevant.
- Save a memory (saveMemory) when the reader expresses a lasting preference, a personal viewpoint, a concept they keep returning to, a framework they use to understand things, or a correction to your behavior.
- Do NOT save book content itself (summaries cover that) or one-off transactional questions. The conversation summary is this session's working memory; only durable cross-session facts belong in saveMemory.
- The index is always visible: merge related entries with updateMemory instead of piling near-duplicates; use deleteMemory when asked to forget or when an entry is obsolete.
- In memory bodies, link related memories with [[slug]]. A [[slug]] that does not exist yet is fine — it marks something worth writing later.
- Write memory content in the reader's language; slugs are always English kebab-case.`;

/** 五层组装的 ①+②+③+④（⑤动态层 PDF note / priorSummary 由调用方拼接）。②③④走会话快照（spec §5）。
 * Memory guidance 按 memoryEnabled 拼接：其变化与④段同源（翻转时 preferences handler 已 invalidate 快照），
 * 会话内输出仍逐字稳定。kind="library" 选 LIBRARY_SYSTEM_PROMPT，默认 "book" 选 BASE_SYSTEM_PROMPT。 */
export function buildSystemPrompt(
  db: DB,
  conversationId: string,
  kind: "book" | "library" = "book",
): string {
  const memoryEnabled = getPreference(db, "memoryEnabled") ?? true;
  const template =
    kind === "library"
      ? LIBRARY_SYSTEM_PROMPT
      : `${BASE_SYSTEM_PROMPT}\n\n${READER_LIBRARY_ADDENDUM}\n\n${LIBRARY_TOOLS_FRAGMENT}`;
  const base = memoryEnabled ? `${template}\n\n${MEMORY_GUIDANCE_PROMPT}` : template;
  const agentContext = getAgentContext(db, conversationId);
  return agentContext.length > 0 ? `${base}\n\n${agentContext}` : base;
}
