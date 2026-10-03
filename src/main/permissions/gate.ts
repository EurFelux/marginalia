// src/main/permissions/gate.ts —— 审批闸门（spec 2026-10-03-bash-skills-permissions-design §5.1、§5.6）。
// 工具的 execute 里 await check()：规则能定的当场返回，定不了的经注入的端口推给渲染层，
// 挂起直到用户答复、本轮被中止或渲染层重载。不碰 Electron / DB，依赖全部注入。
import { v7 as uuidv7 } from "uuid";
import {
  analyzeCommand,
  formatPattern,
  isTokenPrefix,
  parsePattern,
} from "@main/permissions/command";
import { decide, type PolicyContext, type PolicyRule } from "@main/permissions/policy";
import { createLogger } from "@main/logger";
import type {
  ApprovalSource,
  PermissionCancel,
  PermissionRequest,
  PermissionRespondInput,
  PermissionRespondResult,
  PermissionRuleDto,
  PermissionTool,
} from "@shared/permissions";

const log = createLogger("permissions");

/** 主进程 → 渲染层的询问端口（生产实现广播给窗口，测试注入假实现）。 */
export interface AskPort {
  request(request: PermissionRequest): void;
  cancel(cancel: PermissionCancel): void;
}

export interface PermissionGateDeps {
  listRules: () => PermissionRuleDto[];
  addAllowRule: (pattern: string) => void;
  alwaysApprove: () => boolean;
  port: AskPort;
  newId?: () => string;
}

export interface PermissionCheck {
  tool: PermissionTool;
  command: string;
  cwd: string;
  conversationId: string;
  toolCallId: string;
  signal?: AbortSignal;
}

export type PermissionVerdict =
  | { allowed: true; approval: ApprovalSource }
  | { allowed: false; by: "rule"; rule: string }
  | { allowed: false; by: "user"; reason?: string }
  /** 本轮被中止、会话被删除或渲染层重载：请求作废，按拒绝处理。 */
  | { allowed: false; by: "cancelled" };

interface Pending {
  request: PermissionRequest;
  /** 简单命令的词序列；复合命令为 null（不接受「本会话 / 总是允许」）。 */
  tokens: string[] | null;
  settle: (verdict: PermissionVerdict) => void;
}

export class PermissionGate {
  readonly #deps: PermissionGateDeps;
  readonly #pending = new Map<string, Pending>();
  /** conversationId → 本会话允许的前缀。只在内存里：重启或删除会话即清空。 */
  readonly #session = new Map<string, string[][]>();

  constructor(deps: PermissionGateDeps) {
    this.#deps = deps;
  }

  check(input: PermissionCheck): Promise<PermissionVerdict> {
    const analysis = analyzeCommand(input.command);
    const decision = decide(analysis, this.#context(input.tool, input.conversationId));
    if (decision.kind === "deny") {
      return Promise.resolve({ allowed: false, by: "rule", rule: decision.rule });
    }
    if (decision.kind === "allow") {
      return Promise.resolve({ allowed: true, approval: decision.approval });
    }
    if (input.signal?.aborted) return Promise.resolve({ allowed: false, by: "cancelled" });

    const request: PermissionRequest = {
      requestId: (this.#deps.newId ?? uuidv7)(),
      conversationId: input.conversationId,
      toolCallId: input.toolCallId,
      tool: input.tool,
      command: input.command,
      cwd: input.cwd,
      simple: analysis.simple,
      suggestedPrefix: analysis.suggestedPrefix,
    };
    return new Promise<PermissionVerdict>((resolve) => {
      const onAbort = () => this.#cancel(request.requestId);
      input.signal?.addEventListener("abort", onAbort, { once: true });
      this.#pending.set(request.requestId, {
        request,
        tokens: analysis.tokens,
        settle: (verdict) => {
          input.signal?.removeEventListener("abort", onAbort);
          this.#pending.delete(request.requestId);
          resolve(verdict);
        },
      });
      this.#deps.port.request(request);
    });
  }

  /**
   * 用户答复。请求已不在挂起表里（撤销 / 已答复）返回 ok=false；前缀不合法或规则写入失败时抛错，
   * 请求保持挂起，用户可以重选。
   */
  respond(input: PermissionRespondInput): PermissionRespondResult {
    const pending = this.#pending.get(input.requestId);
    if (!pending) return { ok: false };
    switch (input.choice) {
      case "once":
        pending.settle({ allowed: true, approval: "user" });
        break;
      case "session": {
        const prefix = this.#validPrefix(pending, input.prefix);
        const { conversationId } = pending.request;
        this.#session.set(conversationId, [...(this.#session.get(conversationId) ?? []), prefix]);
        pending.settle({ allowed: true, approval: "user" });
        break;
      }
      case "always":
        this.#deps.addAllowRule(formatPattern(this.#validPrefix(pending, input.prefix)));
        pending.settle({ allowed: true, approval: "user" });
        break;
      case "deny":
        pending.settle({ allowed: false, by: "user", reason: input.reason || undefined });
        break;
    }
    return { ok: true };
  }

  /** 撤销全部挂起请求（渲染层重载 / 销毁：看不到这条流了，留着只会永远挂住）。 */
  cancelAll(): void {
    for (const requestId of this.#pending.keys()) this.#cancel(requestId);
  }

  /** 会话删除时清掉它的本会话允许。 */
  clearSession(conversationId: string): void {
    this.#session.delete(conversationId);
  }

  get pendingCount(): number {
    return this.#pending.size;
  }

  #cancel(requestId: string): void {
    const pending = this.#pending.get(requestId);
    if (!pending) return;
    pending.settle({ allowed: false, by: "cancelled" });
    this.#deps.port.cancel({ requestId });
  }

  #validPrefix(pending: Pending, prefix: string): string[] {
    const tokens = parsePattern(prefix);
    if (!pending.tokens || !tokens || !isTokenPrefix(tokens, pending.tokens)) {
      throw new Error(
        `prefix "${prefix}" must be a leading run of whole words of a simple command`,
      );
    }
    return tokens;
  }

  #context(tool: PermissionTool, conversationId: string): PolicyContext {
    const allow: PolicyRule[] = [];
    const deny: PolicyRule[] = [];
    for (const rule of this.#deps.listRules()) {
      if (rule.tool !== tool) continue;
      const tokens = parsePattern(rule.pattern);
      if (!tokens) {
        log.warn(`ignoring unparsable permission rule ${rule.id}: ${rule.pattern}`);
        continue;
      }
      (rule.decision === "allow" ? allow : deny).push({ pattern: rule.pattern, tokens });
    }
    return {
      allow,
      deny,
      session: this.#session.get(conversationId) ?? [],
      alwaysApprove: this.#deps.alwaysApprove(),
    };
  }
}
