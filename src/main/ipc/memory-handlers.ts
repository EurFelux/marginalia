import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import { bind, register, type Binding } from "@main/ipc/registry";
import { deleteMemoryById, listMemories, updateMemoryById } from "@main/memory/repository";

export const memoryBindings: Binding[] = [
  bind(C.memoriesList, () => listMemories(getDb())),
  bind(C.memoriesUpdate, (input) => {
    const row = updateMemoryById(getDb(), input);
    if (!row) return null;
    return listMemories(getDb()).find((m) => m.id === row.id) ?? null;
  }),
  bind(C.memoriesDelete, (input) => deleteMemoryById(getDb(), input.id)),
];

export function registerMemoryHandlers(): void {
  register(memoryBindings);
}
