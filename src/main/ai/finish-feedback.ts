// src/main/ai/finish-feedback.ts
import type { FinishReason } from "ai";
import { t } from "@main/i18n";

export type FinishFeedbackCode = "truncated" | "content-filtered" | "provider-error";

export interface FinishFeedback {
  code: FinishFeedbackCode;
  /** 已本地化的用户可见文案（作为 error chunk 的 errorText 进横幅）。 */
  message: string;
}

/**
 * 一轮回复的 finish reason 是否需要告知用户（spec 2026-09-24 chat-turn-outcome）。
 * provider 契约中 finish reason 与 error part 相互独立，SDK 不会为任何 finish reason 产出 error chunk，
 * 故异常结束须由应用层判定。`other` 视为不规范的返回、静默接受；流级错误不经此函数。
 */
export function finishFeedback(input: {
  finishReason: FinishReason;
  rawFinishReason: string | undefined;
}): FinishFeedback | null {
  switch (input.finishReason) {
    case "length":
      return {
        code: "truncated",
        message: t(
          "errors.replyTruncated",
          "回复达到模型的输出长度上限，内容被截断。可让它继续，或换用输出上限更大的模型。",
        ),
      };
    case "content-filter":
      return {
        code: "content-filtered",
        message: t("errors.replyContentFiltered", "回复被模型服务的内容过滤中止。"),
      };
    case "error":
      return {
        code: "provider-error",
        message: input.rawFinishReason
          ? t(
              "errors.replyProviderErrorWithReason",
              "模型服务报告错误并中止了回复（{{reason}}）。",
              {
                reason: input.rawFinishReason,
              },
            )
          : t("errors.replyProviderError", "模型服务报告错误并中止了回复。"),
      };
    default:
      return null;
  }
}
