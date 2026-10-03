// 工具权限控制的跨层契约（spec 2026-10-03-bash-skills-permissions-design §5）。
import { z } from "zod";

/** 受权限控制的工具。为将来其他工具留位，v1 只有 bash。 */
export const permissionTool = z.enum(["bash"]);
export type PermissionTool = z.infer<typeof permissionTool>;

/** 持久化规则的判定：允许 / 拒绝（询问是无规则命中时的缺省）。 */
export const permissionDecision = z.enum(["allow", "deny"]);
export type PermissionDecision = z.infer<typeof permissionDecision>;

/** 一次放行的来源：用户当场批准 / 本会话允许 / 允许规则 / 总是批准开关。 */
export const approvalSource = z.enum(["user", "session", "rule", "always"]);
export type ApprovalSource = z.infer<typeof approvalSource>;

export interface PermissionRuleDto {
  id: string;
  tool: PermissionTool;
  decision: PermissionDecision;
  /** 规范化后的词前缀（各词经 shell 引用规则转义后以单空格连接）。 */
  pattern: string;
  /** epoch ms。 */
  createdAt: number;
}

export const addPermissionRuleInput = z.object({
  tool: permissionTool,
  decision: permissionDecision,
  pattern: z.string().trim().min(1).max(1000),
});
export type AddPermissionRuleInput = z.infer<typeof addPermissionRuleInput>;

export const permissionRuleIdInput = z.object({ id: z.string().min(1) });

/** main → renderer：请用户批准一次工具调用（`permission:request` 事件载荷）。 */
export interface PermissionRequest {
  requestId: string;
  conversationId: string;
  /** 对应 UIMessage 里的 tool part，渲染层据此把操作栏挂到对应终端块上。 */
  toolCallId: string;
  tool: PermissionTool;
  command: string;
  cwd: string;
  /** 简单命令才可「本会话允许 / 总是允许」；复合命令只能单次批准。 */
  simple: boolean;
  /** 建议的规则前缀；复合命令为 null。 */
  suggestedPrefix: string | null;
}

/** main → renderer：撤销一条挂起的请求（`permission:cancel` 事件载荷）。 */
export interface PermissionCancel {
  requestId: string;
}

const requestId = z.string().min(1);

/** renderer → main：用户对一条请求的选择。prefix 须是该命令的词前缀，由主进程再校验。 */
export const permissionRespondInput = z.discriminatedUnion("choice", [
  z.object({ requestId, choice: z.literal("once") }),
  z.object({ requestId, choice: z.literal("session"), prefix: z.string().trim().min(1).max(1000) }),
  z.object({ requestId, choice: z.literal("always"), prefix: z.string().trim().min(1).max(1000) }),
  z.object({
    requestId,
    choice: z.literal("deny"),
    reason: z.string().trim().max(2000).optional(),
  }),
]);
export type PermissionRespondInput = z.infer<typeof permissionRespondInput>;

/** ok=false：请求已不在挂起表里（已被撤销或已答复），渲染层丢弃即可。 */
export interface PermissionRespondResult {
  ok: boolean;
}
