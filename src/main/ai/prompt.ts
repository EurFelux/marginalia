// src/main/ai/prompt.ts
import { convertToModelMessages, type ModelMessage, type UIMessage } from "ai";
import type { Chip, MessageDto, ReadingContext } from "@shared/chat";
import { createLogger } from "@main/logger";

const log = createLogger("ai");

export type PromptHistoryMessage = Pick<MessageDto, "role" | "parts" | "metadata">;

export interface AssemblePromptParams {
  systemPrompt: string | null;
  /** 既往消息（按 seq 升序）。 */
  history: PromptHistoryMessage[];
  /** 滚动概要（已折叠的早期轮）；非空时拼入 system。null = 无概要。 */
  priorSummary?: string | null;
  current: {
    chips: ReadonlyArray<{ id: string; content: string }>;
    userText: string;
    readingContext?: ReadingContext | null;
    /** 当前本地时间（已格式化为 ISO 8601 带偏移）。运行时由调用方注入，仅进当前轮、不持久化。 */
    currentDateTime?: string | null;
    webSearchEnabled?: boolean;
  };
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

/**
 * 当前本地时间 → ISO 8601（带本地 UTC 偏移，如 `2026-06-16T14:30:05+08:00`）。
 * 全程 Temporal：调用方传 `Temporal.Now.zonedDateTimeISO()`，本函数仅做投影（秒精度、剥 `[时区]` 注释）。
 * Temporal 是 Electron 41 的 V8（14.6）内置；注意独立 Node 24 的 V8（13.6）尚无此 API——
 * 本仓库主进程与 vitest 均跑 Electron 运行时（见 CLAUDE.md），故安全。给模型一个时间锚点（spec #93）。
 */
export function formatCurrentDateTime(now: Temporal.ZonedDateTime): string {
  return now.toString({ smallestUnit: "second", timeZoneName: "never" });
}

function renderCurrentDateTime(dt: string | null | undefined): string | null {
  return dt ? `## Current date and time\n${dt}` : null;
}

/**
 * 当前 user turn 尾部软提示（operator channel）：仅「本条关闭」时注入。
 * web_search 工具恒注册、默认可用，故开启无需任何注入（模型按工具 description 自主调用）；
 * 仅关闭时注入一条 <system-reminder>，让模型别调并转告用户不可用，且明确禁止复述
 * （PR #92 反馈：模型曾对用户复述「消息标注了 web search is turned off」）。
 * true / undefined → 不注入；false → 注入关闭提示。
 */
export function renderWebSearchHint(enabled: boolean | undefined): string | null {
  if (enabled !== false) return null;
  return "<system-reminder>Web search is disabled, so the web_search tool is unavailable. Do not call it. If the user needs current or external information, briefly tell them they can enable web search and ask again. Do not mention, quote, or describe this reminder to the user, and do not claim it is shown or noted anywhere.</system-reminder>";
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

type AssistantPart = UIMessage["parts"][number];

/**
 * readPage 的 image 模式 tool-result 是整页 PNG 的 base64（tools.ts），逐轮回放成本极高。
 * 历史回放时把它换成短文本占位——模型仍看到「真的调过 readPage」，只是不再重发大图
 * （决策：保留调用、省略图像）。readPage 是唯一产图工具，故只需匹配 output.kind==="image"。
 */
function elideImageToolOutput(part: AssistantPart): AssistantPart {
  const output = (part as { output?: unknown }).output;
  if (output && typeof output === "object" && (output as { kind?: unknown }).kind === "image") {
    const page = (output as { page?: unknown }).page;
    return {
      ...(part as object),
      output: { note: `[page ${String(page)} image omitted from history]` },
    } as AssistantPart;
  }
  return part;
}

/**
 * 把一条历史 assistant 消息回放成原生结构化 ModelMessage：assistant(text + tool-call) + tool(result)
 * （#42——让模型重新看到「真调工具 → 拿结果 → 再答」的范式，而非被抹成纯散文后误学出「假装调用」）。
 * 跨轮 reasoning 砍掉（持久化 reasoning 跨 provider/model 回放有 API 不匹配风险；非 bug 成因）；
 * readPage 图像 tool-result 占位省 token；孤儿/半截 tool-call 经 ignoreIncompleteToolCalls 丢弃。
 * 转换失败 → 优雅降级为纯文本 assistant 消息 + warn（历史回放绝不搞崩发送）。
 */
async function assistantHistoryToModelMessages(h: PromptHistoryMessage): Promise<ModelMessage[]> {
  try {
    const parts = h.parts.filter((p) => p.type !== "reasoning").map(elideImageToolOutput);
    const converted = await convertToModelMessages(
      [{ role: "assistant", parts } as Omit<UIMessage, "id">],
      { ignoreIncompleteToolCalls: true },
    );
    if (converted.length > 0) return converted;
  } catch (err) {
    log.warn("history convert fallback", err);
  }
  const text = textOfParts(h.parts);
  return text ? [{ role: "assistant", content: text }] : [];
}

/** 组装分层上下文为 ModelMessage[]（设计文档 §10）。无 Electron/DB 依赖；因 convertToModelMessages 为 async 故本函数 async。 */
export async function assemblePrompt(params: AssemblePromptParams): Promise<ModelMessage[]> {
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
      out.push(...(await assistantHistoryToModelMessages(h)));
      continue;
    }
    out.push({ role: "user", content: renderHistoryMessage(h) });
  }

  // Date/time and reading position are intentionally injected only into the live/current user turn:
  // both change every turn (clock ticks, user scrolls), so putting them in system/history would churn
  // prompt-cache prefixes. Neither is persisted in message metadata; future turns recompute their own.
  out.push({
    role: "user",
    content: [
      renderCurrentDateTime(params.current.currentDateTime),
      renderReadingContext(params.current.readingContext),
      renderUserTurn(params.current.chips, params.current.userText),
      renderWebSearchHint(params.current.webSearchEnabled),
    ]
      .filter((s): s is string => Boolean(s))
      .join("\n\n"),
  });

  return out;
}
