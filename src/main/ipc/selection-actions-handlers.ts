import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import { bind, register, type Binding } from "@main/ipc/registry";
import {
  createSelectionAction,
  deleteSelectionAction,
  listSelectionActions,
  reorderSelectionActions,
  updateSelectionAction,
} from "@main/selection-actions/repository";

const now = () => Temporal.Now.instant().epochMilliseconds;

export const selectionActionsBindings: Binding[] = [
  bind(C.selectionActionsList, () => listSelectionActions(getDb())),
  bind(C.selectionActionsCreate, (input) => createSelectionAction(getDb(), input, now())),
  bind(C.selectionActionsUpdate, (input) => updateSelectionAction(getDb(), input, now())),
  bind(C.selectionActionsDelete, (input) => deleteSelectionAction(getDb(), input.id)),
  bind(C.selectionActionsReorder, (input) => reorderSelectionActions(getDb(), input.ids, now())),
];

export function registerSelectionActionsHandlers(): void {
  register(selectionActionsBindings);
}
