import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import { bind, register, type Binding } from "@main/ipc/registry";
import { getPermissionGate } from "@main/permissions/instance";
import {
  addPermissionRule,
  deletePermissionRule,
  listPermissionRules,
} from "@main/permissions/repository";

export const permissionBindings: Binding[] = [
  bind(C.permissionRespond, (input) => getPermissionGate().respond(input)),
  bind(C.permissionRulesList, () => listPermissionRules(getDb())),
  bind(C.permissionRulesAdd, (input) => addPermissionRule(getDb(), input)),
  bind(C.permissionRulesDelete, (input) => deletePermissionRule(getDb(), input.id)),
];

export function registerPermissionHandlers(): void {
  register(permissionBindings);
}
