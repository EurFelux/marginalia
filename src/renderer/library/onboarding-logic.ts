import type { ChatModel, SummaryModel } from "@shared/preferences";
import type { ProviderDto } from "@shared/providers";

/**
 * 步骤①完成：对话模型偏好已选 provider+model，且该 provider 已配密钥（keyMask 非空）。
 * provider 列表为 undefined（query 加载中）或未找到对应 provider 均返回 false；消费侧须先 gate query 就绪（isPending）再据此判定。
 */
export function isModelConnected(
  chatModel: ChatModel | null,
  providers: ProviderDto[] | undefined,
): boolean {
  if (!chatModel?.providerId || !chatModel.model) return false;
  const provider = providers?.find((p) => p.id === chatModel.providerId);
  return provider != null && provider.keyMask != null;
}

/** onboarding 全部完成 = 模型已连接 且 自动摘要已开。 */
export function isOnboardingComplete(modelConnected: boolean, autoSummarize: boolean): boolean {
  return modelConnected && autoSummarize;
}

/**
 * 开启自动摘要时的 summaryModel 兜底取值（显式写入偏好，不动 resolveSummaryModel 的「绝不回退」契约）：
 *  - 已配 → null（不覆盖用户选择）
 *  - 未配且对话模型齐全 → 对话模型 (providerId, model)
 *  - 对话模型不全 → null（step2 锁定保证不会发生，防御性兜底）
 */
export function summaryModelBackfill(
  current: SummaryModel | null,
  chatModel: ChatModel | null,
): SummaryModel | null {
  if (current) return null;
  if (!chatModel?.providerId || !chatModel.model) return null;
  return { providerId: chatModel.providerId, model: chatModel.model };
}
