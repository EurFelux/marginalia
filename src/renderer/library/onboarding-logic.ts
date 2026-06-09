import type { SummaryModel } from "@shared/preferences";
import type { ProviderDto } from "@shared/providers";

/** 助手当前选中的 provider/model（从 AssistantDto 投影）。 */
type AssistantSelection = { providerId: string | null; model: string | null };

/** 步骤①完成：助手已选 provider+model，且该 provider 已配密钥（keyMask 非空）。 */
export function isModelConnected(
  assistant: AssistantSelection | undefined,
  providers: ProviderDto[] | undefined,
): boolean {
  if (!assistant?.providerId || !assistant.model) return false;
  const provider = providers?.find((p) => p.id === assistant.providerId);
  return provider != null && provider.keyMask != null;
}

/** onboarding 全部完成 = 模型已连接 且 自动摘要已开。 */
export function isOnboardingComplete(modelConnected: boolean, autoSummarize: boolean): boolean {
  return modelConnected && autoSummarize;
}

/**
 * 开启自动摘要时的 summaryModel 兜底取值（显式写入偏好，不动 resolveSummaryModel 的「绝不回退」契约）：
 *  - 已配 → null（不覆盖用户选择）
 *  - 未配且助手模型齐全 → 助手 (providerId, model)
 *  - 助手模型不全 → null（step2 锁定保证不会发生，防御性兜底）
 */
export function summaryModelBackfill(
  current: SummaryModel | null,
  assistant: AssistantSelection | undefined,
): SummaryModel | null {
  if (current) return null;
  if (!assistant?.providerId || !assistant.model) return null;
  return { providerId: assistant.providerId, model: assistant.model };
}
