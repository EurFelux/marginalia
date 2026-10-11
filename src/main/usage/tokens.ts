import { createLogger } from "@main/logger";

const log = createLogger("usage");

/**
 * 剔除落库会被拒收的 token 值（负数、非整数）并留 warn；undefined 原样返回。
 * 消息 metadata.usage 读库校验失败会整条降级为 null（连 model / error 一起丢），
 * 账本列也是非负整数——宁可少存这一项。
 */
export function storableTokens(field: string, value: number | undefined): number | undefined {
  if (value == null || (Number.isInteger(value) && value >= 0)) return value;
  log.warn(`dropping invalid usage value (${field}=${value})`);
  return undefined;
}
