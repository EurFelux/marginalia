// bash 终端块的展示投影（spec 2026-10-03-bash-skills-permissions-design §6.4）：
// tool part 的状态 + 挂起的审批请求 + 回复是否仍在流式 → 徽标与要显示的内容。纯函数，无头可测。
import type { BashToolOutput } from "@shared/bash";
import type { ApprovalSource, PermissionRequest } from "@shared/permissions";
import type { ToolPart } from "@renderer/ai/segments";

export type BashBadge =
  /** 命令还在流式生成：不显示徽标。 */
  | { kind: "none" }
  | { kind: "pending" }
  | { kind: "running" }
  | { kind: "ok" }
  | { kind: "failed"; exitCode: number | null }
  | { kind: "timedOut" }
  | { kind: "aborted" }
  | { kind: "denied"; by: "user" | "rule" }
  | { kind: "error" };

export interface BashView {
  command: string;
  badge: BashBadge;
  /** stdout 后接 stderr；没有输出为空串。 */
  output: string;
  durationMs: number | null;
  truncated: boolean;
  /** 自动批准的来源；用户当场批准（user）不标。 */
  autoApproval: Exclude<ApprovalSource, "user"> | null;
  denial: { by: "user"; reason?: string } | { by: "rule"; rule: string } | null;
  errorMessage: string | null;
  /** 挂起的审批请求：有它就显示操作栏。 */
  request: PermissionRequest | null;
}

function base(command: string, badge: BashBadge): BashView {
  return {
    command,
    badge,
    output: "",
    durationMs: null,
    truncated: false,
    autoApproval: null,
    denial: null,
    errorMessage: null,
    request: null,
  };
}

function isErrorOutput(output: unknown): output is { error: string } {
  return typeof output === "object" && output !== null && "error" in output;
}

export function bashView(
  part: ToolPart,
  request: PermissionRequest | undefined,
  streaming: boolean,
): BashView {
  const input = part.input as { command?: unknown } | undefined;
  const command = typeof input?.command === "string" ? input.command : "";

  if (part.state === "output-error") {
    return { ...base(command, { kind: "error" }), errorMessage: part.errorText };
  }
  if (part.state !== "output-available") {
    if (request) return { ...base(command, { kind: "pending" }), request };
    // 回复已结束却没有结果：几乎都是用户点了停止（等待批准时或运行中），中断整轮后结果来不及回传；
    // 两种情况此处分不开，统一显示「已中止」。
    if (!streaming) return base(command, { kind: "aborted" });
    return base(command, part.state === "input-streaming" ? { kind: "none" } : { kind: "running" });
  }

  const output = part.output as BashToolOutput | { error: string };
  if (isErrorOutput(output)) {
    return { ...base(command, { kind: "error" }), errorMessage: output.error };
  }
  switch (output.status) {
    case "ran": {
      const badge: BashBadge = output.timedOut
        ? { kind: "timedOut" }
        : output.aborted
          ? { kind: "aborted" }
          : output.exitCode === 0
            ? { kind: "ok" }
            : { kind: "failed", exitCode: output.exitCode };
      return {
        ...base(command, badge),
        output: output.stdout + output.stderr,
        durationMs: output.durationMs,
        truncated: output.truncated,
        autoApproval: output.approval === "user" ? null : output.approval,
      };
    }
    case "denied":
      return {
        ...base(command, { kind: "denied", by: output.by }),
        denial:
          output.by === "rule"
            ? { by: "rule", rule: output.rule ?? "" }
            : { by: "user", reason: output.reason },
      };
    case "cancelled":
      return base(command, { kind: "aborted" });
  }
}

/** 耗时的展示分解（整数运算）：一分钟内精确到百分之一秒，之上到秒。 */
export function durationParts(
  ms: number,
): { unit: "sec"; sec: number; centi: string } | { unit: "min"; min: number; sec: number } {
  const centi = Math.round(ms / 10);
  if (centi < 6000) {
    return {
      unit: "sec",
      sec: Math.floor(centi / 100),
      centi: String(centi % 100).padStart(2, "0"),
    };
  }
  const total = Math.round(ms / 1000);
  return { unit: "min", min: Math.floor(total / 60), sec: total % 60 };
}
