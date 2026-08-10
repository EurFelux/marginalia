// src/main/reading-report/investigation-runner.ts —— 把纯逻辑的会话调查接到真实模型与并发额度上。
import { generateText } from "ai";
import type { ResolvedModel } from "@main/ai/assistant-model";
import { acquireSlot, type RunBackground } from "@main/ai/background-limiter";
import { providerCallOptions } from "@main/ai/model-factory";
import type { DB } from "@main/db/client";
import type { ReadingSessionRow } from "@main/reading-sessions/repository";
import { readSessionConversation } from "@main/reading-report/evidence";
import {
  investigateConversation,
  INVESTIGATION_SLOT_TIMEOUT_MS,
  INVESTIGATION_SYSTEM,
  type ConversationInvestigation,
} from "@main/reading-report/investigator";

export interface InvestigatorDeps {
  db: DB;
  session: ReadingSessionRow;
  resolved: Extract<ResolvedModel, { ok: true }>;
  runBackground: RunBackground;
  abortSignal: AbortSignal;
}

export type Investigate = (input: {
  conversationId: string;
  focus?: string;
}) => Promise<ConversationInvestigation | null>;

/**
 * 生产实现：整次调查占**全局**后台并发的一个槽位——用户在设置里调的并发上限因此对 subagent
 * 真实有效（报告主 agent 是用户显式触发的前台任务，不占该池，故不存在内外层互等的自锁）。
 * 超时未排到槽位返回 null，由工具层转成 busy 让主 agent 自行翻页。
 */
export function createInvestigator(deps: InvestigatorDeps): Investigate {
  return async ({ conversationId, focus }) => {
    const slot = await acquireSlot(deps.runBackground, INVESTIGATION_SLOT_TIMEOUT_MS);
    if (!slot.ok) return null;
    try {
      return await investigateConversation({
        focus,
        readPage: (options) =>
          readSessionConversation(deps.db, deps.session, conversationId, options),
        generate: async (prompt) => {
          const { text } = await generateText({
            model: deps.resolved.model,
            reasoning: deps.resolved.reasoningEffort,
            instructions: INVESTIGATION_SYSTEM,
            prompt,
            providerOptions: providerCallOptions(deps.resolved.providerType),
            abortSignal: deps.abortSignal,
            // 刻意不设 maxOutputTokens：与 runReadingReportAgent 同理，推理模型的思考 token 与
            // 正文共享该预算，小额度会让要点一条不出。
            maxRetries: 1,
          });
          return text;
        },
      });
    } finally {
      slot.release();
    }
  };
}
