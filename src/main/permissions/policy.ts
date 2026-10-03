// src/main/permissions/policy.ts —— 判定顺序（spec 2026-10-03 §5.1）。纯函数，命中即停：
// 拒绝规则 → 总是批准 → 允许规则 → 本会话允许 → 询问。
import { isTokenPrefix, type CommandAnalysis } from "@main/permissions/command";

export interface PolicyRule {
  pattern: string;
  tokens: string[];
}

export interface PolicyContext {
  allow: PolicyRule[];
  deny: PolicyRule[];
  /** 本会话允许的前缀（词序列）。 */
  session: string[][];
  alwaysApprove: boolean;
}

export type PolicyDecision =
  | { kind: "deny"; rule: string }
  | { kind: "allow"; approval: "always" | "rule" | "session" }
  | { kind: "ask" };

export function decide(analysis: CommandAnalysis, ctx: PolicyContext): PolicyDecision {
  // 拒绝规则对复合命令逐段检查：任一段以规则开头即拦下，「总是批准」也绕不过。
  for (const rule of ctx.deny) {
    if (analysis.segments.some((segment) => isTokenPrefix(rule.tokens, segment))) {
      return { kind: "deny", rule: rule.pattern };
    }
  }
  if (ctx.alwaysApprove) return { kind: "allow", approval: "always" };
  // 允许规则与本会话允许只放行简单命令：复合命令开头匹配也照常询问。
  const tokens = analysis.tokens;
  if (tokens) {
    if (ctx.allow.some((rule) => isTokenPrefix(rule.tokens, tokens))) {
      return { kind: "allow", approval: "rule" };
    }
    if (ctx.session.some((prefix) => isTokenPrefix(prefix, tokens))) {
      return { kind: "allow", approval: "session" };
    }
  }
  return { kind: "ask" };
}
