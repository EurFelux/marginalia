import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import { storeAvatar, resetAvatar } from "@main/ai/agent-avatar";
import { bind, register, type Binding } from "@main/ipc/registry";

export const agentBindings: Binding[] = [
  bind(C.agentResetAvatar, () => resetAvatar(getDb())),

  bind(C.agentSetAvatar, (bytes) => storeAvatar(getDb(), bytes)),
];

export function registerAgentHandlers(): void {
  register(agentBindings);
}
