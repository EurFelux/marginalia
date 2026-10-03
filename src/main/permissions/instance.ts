// src/main/permissions/instance.ts —— 审批闸门的进程级单例：注入 DB 规则、偏好与渲染层端口。
// 挂起请求与本会话允许都在这一个实例里，bash 工具（#121）与 IPC handler 共用它。
import { getDb } from "@main/db/instance";
import { getPreference } from "@main/preferences/repository";
import { permissionAskPort } from "@main/notify";
import { PermissionGate } from "@main/permissions/gate";
import { addPermissionRule, listPermissionRules } from "@main/permissions/repository";

let gate: PermissionGate | null = null;

export function getPermissionGate(): PermissionGate {
  gate ??= new PermissionGate({
    listRules: () => listPermissionRules(getDb()),
    addAllowRule: (pattern) =>
      void addPermissionRule(getDb(), { tool: "bash", decision: "allow", pattern }),
    alwaysApprove: () => getPreference(getDb(), "bashAlwaysApprove") ?? false,
    port: permissionAskPort,
  });
  return gate;
}
