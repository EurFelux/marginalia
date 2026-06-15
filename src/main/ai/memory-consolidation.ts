// src/main/ai/memory-consolidation.ts —— 后台记忆整理 pass（spec 2026-06-16）。
// 结构化单发 + 确定性落库；镜像 context-compaction.ts 的 fire-and-forget 形态。
import { z } from "zod";
import { generateObject } from "ai";
import { eq } from "drizzle-orm";
import {
  createMemory,
  deleteMemoryById,
  getMemoryBySlug,
  listMemories,
  updateMemoryById,
} from "@main/memory/repository";
import { memorySlug } from "@shared/memory";
import { renderHistoryMessage } from "@main/ai/prompt";
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
export function applyMemoryOps(
  db: DB,
  ops: MemoryOp[],
  opts: { sourceBookId: string | null },
): ApplyResult {
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
          sourceBookId: opts.sourceBookId,
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

/** 渲染整理输入：现有记忆全库（含正文）+ 最近对话转写。超长前载截断保留较新内容。 */
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
  const transcript = turns
    .map((m) => `${m.role === "assistant" ? "Assistant" : "User"}: ${renderHistoryMessage(m)}`)
    .join("\n\n");
  const combined = `## Existing memories\n\n${memoryBlock}\n\n## Recent conversation\n\n${transcript}`;
  return combined.length > maxChars ? combined.slice(combined.length - maxChars) : combined;
}

const CONSOLIDATION_SYSTEM =
  "You are the memory librarian for a reading assistant named Lia. You are given Lia's existing " +
  "long-term memories about the reader and the most recent exchanges of one conversation. Keep the " +
  "memory store accurate and tidy by emitting a list of operations.\n\n" +
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
  "an empty ops array. Give a one-sentence reason for each operation.";

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
  bookId: string | null,
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
  if (assistantTurns < everyN) return; // 未到阈值

  const resolved = resolveModel();
  if (!resolved.ok) {
    log.warn("summary model not configured; skip consolidation", resolved.reason);
    return;
  }

  consolidatingConversations.add(conversationId);
  try {
    const memories = listMemories(db);
    const input = renderMemoryPassInput(tail, memories);
    const { object } = await runBackground(() =>
      generateObject({
        model: resolved.model,
        schema: memoryPassOutput,
        system: CONSOLIDATION_SYSTEM,
        prompt: input,
        maxOutputTokens: MEMORY_PASS_MAX_TOKENS,
        maxRetries: 1,
      }),
    );

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

    const applied = applyMemoryOps(db, object.ops, { sourceBookId: bookId });
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
    }
    log.debug(
      `consolidation done conv=${conversationId} saved=${applied.saved} updated=${applied.updated} deleted=${applied.deleted}`,
    );
  } catch (err) {
    log.warn(`conversation ${conversationId} consolidation failed`, err);
  } finally {
    consolidatingConversations.delete(conversationId);
  }
}
