// bash 工具的跨层契约（spec 2026-10-03-bash-skills-permissions-design §5.7、§6.1）：
// 主进程产出、存进 messages.parts、渲染层终端块解析。
import type { ApprovalSource } from "@shared/permissions";

export const BASH_DEFAULT_TIMEOUT_SEC = 120;
export const BASH_MAX_TIMEOUT_SEC = 600;

/** 命令执行完（含超时 / 中止 / 非 0 退出）。 */
export interface BashRanOutput {
  status: "ran";
  /** 被信号结束时为 null。 */
  exitCode: number | null;
  stdout: string;
  stderr: string;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  /** 整数毫秒。 */
  durationMs: number;
  approval: ApprovalSource;
}

/** 被用户或拒绝规则拦下；message 是给模型的处理说明。 */
export interface BashDeniedOutput {
  status: "denied";
  by: "user" | "rule";
  reason?: string;
  rule?: string;
  message: string;
}

/** 等待批准时本轮被中止 / 会话被删除 / 界面重载：命令没有运行。 */
export interface BashCancelledOutput {
  status: "cancelled";
  message: string;
}

export type BashToolOutput = BashRanOutput | BashDeniedOutput | BashCancelledOutput;

/** 设置页展示的工作目录状态。 */
export interface BashWorkdirInfo {
  /** 实际生效的路径（自定义或默认工作区）。 */
  path: string;
  isDefault: boolean;
  /** 自定义目录可能已被删除；默认工作区首次使用前也不存在（用时自动创建）。 */
  exists: boolean;
}
