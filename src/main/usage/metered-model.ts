import { wrapLanguageModel } from "ai";
import type { LanguageModelV4StreamPart, LanguageModelV4Usage } from "@ai-sdk/provider";
import type { DB } from "@main/db/client";
import type { ChatModel } from "@main/ai/model-factory";
import { insertUsage, ledgerTokens } from "@main/usage/ledger";
import { createLogger } from "@main/logger";
import type { UsagePurpose } from "@shared/stats";

const log = createLogger("usage");

export interface MeterContext {
  db: DB;
  purpose: UsagePurpose;
  /** 所属的书；书库对话及其触发的后台任务为 null。 */
  bookId: string | null;
}

/**
 * 给模型套一层计量中间件：每次模型请求完成就往用量账本追加一行
 * （spec 2026-10-12-ai-usage-stats-design §4.2）。请求失败、或流在 finish 前被中止
 * 时没有用量，不记。写账本失败只留 warn，不影响 AI 调用本身。
 */
export function meteredModel(
  resolved: { model: ChatModel; modelId: string },
  ctx: MeterContext,
): ChatModel {
  const record = (usage: LanguageModelV4Usage) => {
    try {
      const tokens = ledgerTokens(usage);
      if (!tokens) {
        log.warn(
          `${resolved.modelId} reported no input/output total; ${ctx.purpose} request not recorded`,
        );
        return;
      }
      insertUsage(ctx.db, {
        ...tokens,
        createdAt: Temporal.Now.instant().epochMilliseconds,
        purpose: ctx.purpose,
        model: resolved.modelId,
        bookId: ctx.bookId,
        requests: 1,
      });
    } catch (err) {
      log.warn(`recording ${ctx.purpose} usage failed`, err);
    }
  };

  return wrapLanguageModel({
    model: resolved.model,
    middleware: {
      specificationVersion: "v4",
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        record(result.usage);
        return result;
      },
      wrapStream: async ({ doStream }) => {
        const { stream, ...rest } = await doStream();
        const tap = new TransformStream<LanguageModelV4StreamPart, LanguageModelV4StreamPart>({
          transform(part, controller) {
            if (part.type === "finish") record(part.usage);
            controller.enqueue(part);
          },
        });
        return { ...rest, stream: stream.pipeThrough(tap) };
      },
    },
  });
}
