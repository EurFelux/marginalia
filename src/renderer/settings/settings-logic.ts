import type { AiProviderApiType, UpsertProviderInput } from "@shared/providers";
import { DEFAULT_STEP_LIMIT } from "@shared/preferences";

export interface ProviderFormState {
  id: string | undefined; // 有=编辑，无=新建
  type: AiProviderApiType;
  label: string;
  baseUrl: string;
  apiKey: string; // 空=不改 key（编辑保留 / 新建无 key）
  models: string[];
}

/** 并集去重、保序。 */
export function mergeModels(existing: string[], add: string[]): string[] {
  const seen = new Set(existing);
  const out = [...existing];
  for (const m of add) {
    if (!seen.has(m)) {
      seen.add(m);
      out.push(m);
    }
  }
  return out;
}

/** model 下拉选项：provider 的 models ∪ {当前已存 model（若不在列表）}。 */
export function providerModelOptions(providerModels: string[], current: string | null): string[] {
  if (current && !providerModels.includes(current)) return [...providerModels, current];
  return [...providerModels];
}

/** 数字输入框的 stepLimit 取值收敛到 [1, 99] 整数；非有限值（空输入/NaN）回退默认。
 *  注意：0（不限制）不经此函数——它由「不限制」复选框直接产生、不走数字框。 */
export function clampStepLimit(raw: number): number {
  if (!Number.isFinite(raw)) return DEFAULT_STEP_LIMIT;
  return Math.min(99, Math.max(1, Math.trunc(raw)));
}

/** 表单态 → upsert IPC 入参：空 baseUrl→null、空 label→null、空 apiKey 省略（不改 key）、id 省略=新建。 */
export function providerFormToUpsertInput(f: ProviderFormState): UpsertProviderInput {
  const out: UpsertProviderInput = {
    type: f.type,
    label: f.label.trim() ? f.label.trim() : null,
    baseUrl: f.baseUrl.trim() ? f.baseUrl.trim() : null,
    models: f.models,
  };
  if (f.id) out.id = f.id;
  if (f.apiKey.trim()) out.apiKey = f.apiKey.trim();
  return out;
}
