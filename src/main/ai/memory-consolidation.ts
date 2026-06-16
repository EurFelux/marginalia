// src/main/ai/memory-consolidation.ts —— 后台记忆整理 pass（spec 2026-06-16）。
// generateText 单发 + 自管 JSON 解析（parseMemoryOps）+ 确定性落库；镜像 context-compaction.ts 的 fire-and-forget。
// 不用 generateObject/response_format——OpenAI 兼容 provider 对 json_object 支持参差、tool 模式亦不可靠；
// 自己解析对任何文本模型都通用，且解析逻辑可单测。
import { z } from "zod";
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import {
  createMemory,
  deleteMemoryById,
  getMemoryBySlug,
  listMemories,
  updateMemoryById,
} from "@main/memory/repository";
import { memorySlug } from "@shared/memory";
import { renderRoleTaggedTranscript } from "@main/ai/prompt";
import { conversations } from "@main/db/schema";
import { listMessagesAfterSeq } from "@main/chat/messages";
import { getPreference } from "@main/preferences/repository";
import type { DB } from "@main/db/client";
import type { MessageDto } from "@shared/chat";
import type { MemoryDto } from "@shared/memory";
import type { ResolvedModel } from "@main/ai/assistant-model";
import type { RunBackground } from "@main/ai/background-limiter";
import type { AppNotification } from "@shared/chat";
import { createLogger } from "@main/logger";

const log = createLogger("memory");

/** 每 N 轮（assistant 轮数）触发一次后台整理。 */
export const MEMORY_PASS_EVERY_N_TURNS = 5;
/** 喂模型的整理输入字符上限（超长前载截断，保留较新内容）。 */
export const MEMORY_PASS_INPUT_MAX_CHARS = 180_000;
/** 单次整理产出的输出 token 上限。 */
export const MEMORY_PASS_MAX_TOKENS = 8192;

/** 整理操作清单（判别联合）：模型只产出它，纯函数确定性 apply。 */
const memoryOp = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("save"),
    slug: memorySlug,
    title: z.string().min(1),
    description: z.string().min(1),
    body: z.string().min(1),
    reason: z.string(),
  }),
  z.object({
    op: z.literal("update"),
    slug: memorySlug,
    title: z.string().min(1).optional(),
    description: z.string().min(1).optional(),
    body: z.string().min(1).optional(),
    reason: z.string(),
  }),
  z.object({ op: z.literal("delete"), slug: memorySlug, reason: z.string() }),
]);
export const memoryPassOutput = z.object({ ops: z.array(memoryOp) });
export type MemoryOp = z.infer<typeof memoryOp>;

export interface ApplyResult {
  saved: number;
  updated: number;
  deleted: number;
}

/** 确定性把操作清单落库；复用 repository CRUD（连带 [[slug]] 边表同步）。逐条 try/catch 隔离。 */
export function applyMemoryOps(db: DB, ops: MemoryOp[]): ApplyResult {
  const result: ApplyResult = { saved: 0, updated: 0, deleted: 0 };
  for (const op of ops) {
    try {
      if (op.op === "save") {
        if (getMemoryBySlug(db, op.slug)) {
          log.warn(`consolidate: save slug exists, skip: ${op.slug}`);
          continue;
        }
        createMemory(db, {
          slug: op.slug,
          title: op.title,
          description: op.description,
          body: op.body,
        });
        result.saved++;
      } else if (op.op === "update") {
        const existing = getMemoryBySlug(db, op.slug);
        if (!existing) {
          log.warn(`consolidate: update slug missing, skip: ${op.slug}`);
          continue;
        }
        updateMemoryById(db, {
          id: existing.id,
          title: op.title,
          description: op.description,
          body: op.body,
        });
        result.updated++;
      } else {
        const existing = getMemoryBySlug(db, op.slug);
        if (!existing) {
          log.warn(`consolidate: delete slug missing, skip: ${op.slug}`);
          continue;
        }
        deleteMemoryById(db, existing.id);
        result.deleted++;
      }
    } catch (err) {
      log.warn(`consolidate: op failed (${op.op} ${op.slug})`, err);
    }
  }
  return result;
}

/** 渲染整理输入：现有记忆全库（含正文）+ 最近对话转写（角色用 <user>/<assistant> 标签清晰分隔，
 * 与上下文压缩共用 renderRoleTaggedTranscript，正文同走 renderHistoryMessage）。超长前载截断保留较新内容。 */
export function renderMemoryPassInput(
  turns: MessageDto[],
  memories: MemoryDto[],
  maxChars = MEMORY_PASS_INPUT_MAX_CHARS,
): string {
  const memoryBlock =
    memories.length === 0
      ? "(no existing memories)"
      : memories
          .map(
            (m) => `- [${m.slug}] ${m.title} — ${m.description}\n  ${m.body.replace(/\n/g, " ")}`,
          )
          .join("\n");
  const transcript = renderRoleTaggedTranscript(turns);
  const combined = `## Existing memories\n\n${memoryBlock}\n\n## Recent conversation (oldest first)\n\n${transcript}`;
  return combined.length > maxChars ? combined.slice(combined.length - maxChars) : combined;
}

/** 剥 markdown 代码围栏并扫出最外层平衡的 {…}（容忍模型在 JSON 前后夹带 prose）；找不到返回 null。 */
function extractJsonObject(text: string): string | null {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fenced?.[1] ?? text;
  const start = body.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < body.length; i++) {
    const ch = body[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") depth++;
    else if (ch === "}" && --depth === 0) return body.slice(start, i + 1);
  }
  return null;
}

/**
 * 从模型文本健壮地抽取并校验 ops 清单（provider 无关，不依赖 response_format）：
 * 剥围栏 → 平衡括号扫出最外层对象 → JSON.parse → Zod 校验。任何失败返回 null（调用方跳过本轮重试）。
 */
export function parseMemoryOps(text: string): z.infer<typeof memoryPassOutput> | null {
  const json = extractJsonObject(text);
  if (json == null) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return null;
  }
  const parsed = memoryPassOutput.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// prompt 把输出格式说清楚并给范例，让模型直接吐可被 parseMemoryOps 解析的 JSON（无 response_format 依赖）。
export const CONSOLIDATION_SYSTEM =
  "You are the memory librarian for a reading assistant named Lia. You are given Lia's existing " +
  "long-term memories about the reader and the most recent exchanges of one conversation. Keep the " +
  "memory store accurate and tidy by emitting a list of operations.\n\n" +
  "The conversation is given as <user> and <assistant> turns. Attribute facts carefully: only text " +
  "the reader wrote inside <user> reflects the reader. Inside a <user> turn, sections like " +
  '"## 选中文本" / "## 全书概要" / "## 本章概要" / "## 周围上下文" are book material the reader was ' +
  "viewing — quoted content, NOT the reader's own words or opinions. Text inside <assistant> is Lia " +
  "speaking, not the reader. Never attribute a book passage's claims to the reader.\n\n" +
  'Save (op "save") a NEW memory only for durable facts worth remembering across conversations: the ' +
  "reader's lasting preferences, distinctive viewpoints, recurring concepts, thinking frameworks, or " +
  "corrections to Lia's behavior. Do NOT save book content (summaries cover that) or one-off, " +
  'transactional questions. Reuse an existing topic with "update" instead of creating near-duplicates.\n\n' +
  'Update (op "update") to merge near-duplicates into one canonical memory, refine unclear wording, or ' +
  "enrich an existing memory. Body is replaced wholesale when provided.\n\n" +
  'Delete (op "delete") ONLY a redundant duplicate whose content you have merged into another memory in ' +
  "the same batch. NEVER delete a memory just because it looks old or stale — only the reader can judge that.\n\n" +
  "Write memory content in the reader's language; slugs are always English kebab-case. Link related " +
  "memories inside body text with [[slug]]. Be conservative: if nothing is clearly worth changing, return " +
  "an empty ops array. Give a one-sentence reason for each operation.\n\n" +
  "Output ONLY a JSON object — no markdown fences, no prose before or after. Shape:\n" +
  '{"ops": [\n' +
  '  {"op": "save", "slug": "kebab-case-slug", "title": "...", "description": "...", "body": "...", "reason": "..."},\n' +
  '  {"op": "update", "slug": "existing-slug", "title": "...", "description": "...", "body": "...", "reason": "..."},\n' +
  '  {"op": "delete", "slug": "redundant-slug", "reason": "..."}\n' +
  "]}\n" +
  'For "update", include only the fields you are changing. If nothing should change, output {"ops": []}.';

export interface ConsolidationDeps {
  db: DB;
  /** 摘要模型解析器（与压缩/命名/摘要同源 resolveSummaryModel）。 */
  resolveModel: () => ResolvedModel;
  /** 后台并发限流端口（与摘要/命名/压缩共用全局上限）。 */
  runBackground: RunBackground;
  /** main→renderer 通知端口（生产=notifyRenderer，测试注入 spy）。 */
  notify: (n: AppNotification) => void;
}

// 整理中状态：进程内瞬态去重（镜像 compaction 的 inFlight），重启自然归零。
const consolidatingConversations = new Set<string>();

/** 仅供测试：清空整理运行时态。 */
export function __resetConsolidationRuntime(): void {
  consolidatingConversations.clear();
}

/**
 * 轮后 fire-and-forget：每 everyN 个 assistant 轮跑一次。读水位线后的对话切片 + 现有记忆全库，
 * 结构化单发产出操作清单，确定性落库，推进 memoryThroughSeq；有变更才通知。失败/未配模型/会话被删
 * 一律 warn 并保持原状（下轮重试），绝不阻塞发送。门控双闸：memoryEnabled + memoryAutoConsolidate。
 */
export async function maybeConsolidateMemory(
  deps: ConsolidationDeps,
  conversationId: string,
  everyN = MEMORY_PASS_EVERY_N_TURNS,
): Promise<void> {
  const { db, resolveModel, runBackground, notify } = deps;

  // 门控双闸
  const memoryEnabled = getPreference(db, "memoryEnabled") ?? true;
  if (!memoryEnabled) return;
  const auto = getPreference(db, "memoryAutoConsolidate") ?? false;
  if (!auto) return;

  if (consolidatingConversations.has(conversationId)) return; // 并发去重

  const convo = db
    .select({ through: conversations.memoryThroughSeq })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  if (!convo) return; // 会话已删

  const through = convo.through ?? null;
  const tail = listMessagesAfterSeq(db, conversationId, through);
  const assistantTurns = tail.filter((m) => m.role === "assistant").length;
  if (assistantTurns < everyN) {
    log.debug(`consolidation pending conv=${conversationId} turns=${assistantTurns}/${everyN}`);
    return; // 未到阈值
  }

  const resolved = resolveModel();
  if (!resolved.ok) {
    log.warn("summary model not configured; skip consolidation", resolved.reason);
    return;
  }

  consolidatingConversations.add(conversationId);
  try {
    const memories = listMemories(db);
    const input = renderMemoryPassInput(tail, memories);
    log.debug(
      `consolidation start conv=${conversationId} turns=${assistantTurns} memories=${memories.length} inputChars=${input.length}`,
    );
    const { text } = await runBackground(() =>
      generateText({
        model: resolved.model,
        system: CONSOLIDATION_SYSTEM,
        prompt: input,
        maxOutputTokens: MEMORY_PASS_MAX_TOKENS,
        maxRetries: 1,
      }),
    );
    const parsed = parseMemoryOps(text);
    if (!parsed) {
      log.warn(
        `conversation ${conversationId} consolidation: unparseable model output; skip (retry next turn)`,
      );
      return; // 不推进水位线，下轮重试
    }

    // 写回前复查会话仍在（整理中途被删 → 丢弃；better-sqlite3 同步驱动，check-then-act 安全）
    const still = db
      .select({ id: conversations.id })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();
    if (!still) {
      log.debug("conversation deleted mid-consolidation; drop", conversationId);
      return;
    }

    const applied = applyMemoryOps(db, parsed.ops);
    const latestSeq = tail.at(-1)?.seq ?? through ?? 0;
    db.update(conversations)
      .set({ memoryThroughSeq: latestSeq })
      .where(eq(conversations.id, conversationId))
      .run();

    const total = applied.saved + applied.updated + applied.deleted;
    if (total > 0) {
      notify({
        kind: "memoryConsolidated",
        saved: applied.saved,
        updated: applied.updated,
        deleted: applied.deleted,
      });
      log.info(
        `consolidated memories conv=${conversationId} saved=${applied.saved} updated=${applied.updated} deleted=${applied.deleted}`,
      );
    } else {
      log.debug(`consolidation produced no changes conv=${conversationId} (empty ops)`);
    }
  } catch (err) {
    log.warn(`conversation ${conversationId} consolidation failed`, err);
  } finally {
    consolidatingConversations.delete(conversationId);
  }
}
