// src/main/selection-actions/repository.ts —— 划词指令的读写（spec 2026-10-12-custom-selection-actions-design §3.2）。
// 纯函数注入 DB 与时间。读取宽松（逐行校验形状、不查上限），写入严格（上限由 IPC 入参 schema 把关）。
import { asc, eq, sql } from "drizzle-orm";
import type { DB, DBTransaction } from "@main/db/client";
import { selectionActions } from "@main/db/schema";
import { createLogger } from "@main/logger";
import {
  BUILTIN_SELECTION_ACTION_IDS,
  SELECTION_ACTION_MAX,
  builtinSelectionActionId,
  defaultBuiltinSelectionAction,
  type CreateSelectionActionInput,
  type SelectionActionDto,
  type UpdateSelectionActionInput,
} from "@shared/selection-actions";

const log = createLogger("selection");

type Row = typeof selectionActions.$inferSelect;

const nonEmpty = (v: string | null): v is string => v !== null && v.trim() !== "";

/** 一行 → DTO；形状不合当前规则（已不存在的内置 id、自建行字段为空白）返回 null。 */
function toDto(row: Row): SelectionActionDto | null {
  const base = { enabled: row.enabled, autoSend: row.autoSend };
  if (row.kind === "builtin") {
    const id = builtinSelectionActionId.safeParse(row.id);
    if (!id.success) return null;
    return {
      kind: "builtin",
      id: id.data,
      prompt: nonEmpty(row.prompt) ? row.prompt : null,
      ...base,
    };
  }
  if (!nonEmpty(row.label) || !nonEmpty(row.icon) || !nonEmpty(row.prompt)) return null;
  return {
    kind: "custom",
    id: row.id,
    label: row.label,
    icon: row.icon,
    prompt: row.prompt,
    ...base,
  };
}

function readList(db: DB | DBTransaction): SelectionActionDto[] {
  const rows = db
    .select()
    .from(selectionActions)
    .orderBy(asc(selectionActions.position), asc(selectionActions.createdAt))
    .all();
  const out: SelectionActionDto[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const dto = toDto(row);
    if (!dto) {
      log.warn(`skipping malformed selection action row ${row.id}`);
      continue;
    }
    seen.add(dto.id);
    out.push(dto);
  }
  for (const id of BUILTIN_SELECTION_ACTION_IDS) {
    if (!seen.has(id)) out.push(defaultBuiltinSelectionAction(id));
  }
  return out;
}

/** 完整列表：表里的行按 position 排，缺行的内置指令按出厂顺序补在末尾。 */
export function listSelectionActions(db: DB): SelectionActionDto[] {
  return readList(db);
}

function nextPosition(tx: DBTransaction): number {
  const row = tx
    .select({ max: sql<number | null>`max(${selectionActions.position})` })
    .from(selectionActions)
    .get();
  return (row?.max ?? -1) + 1;
}

/** 写之前把缺行的内置指令补成行（排在现有行之后），使新建的自建指令不会排到它们前面。 */
function ensureBuiltinRows(tx: DBTransaction, now: number): void {
  const stored = new Set(
    tx
      .select({ id: selectionActions.id })
      .from(selectionActions)
      .where(eq(selectionActions.kind, "builtin"))
      .all()
      .map((r) => r.id),
  );
  let position = nextPosition(tx);
  for (const id of BUILTIN_SELECTION_ACTION_IDS) {
    if (stored.has(id)) continue;
    tx.insert(selectionActions)
      .values({ id, kind: "builtin", position, createdAt: now, updatedAt: now })
      .run();
    position++;
  }
}

function findDto(tx: DBTransaction, id: string): SelectionActionDto | null {
  const row = tx.select().from(selectionActions).where(eq(selectionActions.id, id)).get();
  return row ? toDto(row) : null;
}

export function createSelectionAction(
  db: DB,
  input: CreateSelectionActionInput,
  now: number,
): SelectionActionDto {
  return db.transaction((tx) => {
    if (readList(tx).length >= SELECTION_ACTION_MAX) {
      throw new Error(`there can be at most ${SELECTION_ACTION_MAX} selection actions`);
    }
    ensureBuiltinRows(tx, now);
    const row = tx
      .insert(selectionActions)
      .values({
        kind: "custom",
        label: input.label,
        icon: input.icon,
        prompt: input.prompt,
        autoSend: input.autoSend,
        position: nextPosition(tx),
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .get();
    return toDto(row)!;
  });
}

export function updateSelectionAction(
  db: DB,
  input: UpdateSelectionActionInput,
  now: number,
): SelectionActionDto {
  return db.transaction((tx) => {
    ensureBuiltinRows(tx, now);
    const current = findDto(tx, input.id);
    if (!current || current.kind !== input.kind) {
      throw new Error(`${input.kind} selection action ${input.id} not found`);
    }
    tx.update(selectionActions)
      .set({ ...input.patch, updatedAt: now })
      .where(eq(selectionActions.id, input.id))
      .run();
    return findDto(tx, input.id)!;
  });
}

export function deleteSelectionAction(db: DB, id: string): void {
  db.transaction((tx) => {
    const current = findDto(tx, id);
    if (current?.kind === "builtin" || builtinSelectionActionId.safeParse(id).success) {
      throw new Error(`built-in selection action ${id} cannot be deleted`);
    }
    if (!current) throw new Error(`selection action ${id} not found`);
    tx.delete(selectionActions).where(eq(selectionActions.id, id)).run();
  });
}

/** 按给定顺序整表重写 position；ids 必须正好是当前列表的一个排列。 */
export function reorderSelectionActions(db: DB, ids: string[], now: number): SelectionActionDto[] {
  return db.transaction((tx) => {
    const current = readList(tx).map((a) => a.id);
    const given = new Set(ids);
    const isPermutation =
      ids.length === current.length &&
      given.size === ids.length &&
      current.every((id) => given.has(id));
    if (!isPermutation) {
      throw new Error("selection action order must be a permutation of the current list");
    }
    ensureBuiltinRows(tx, now);
    ids.forEach((id, position) => {
      tx.update(selectionActions)
        .set({ position, updatedAt: now })
        .where(eq(selectionActions.id, id))
        .run();
    });
    return readList(tx);
  });
}
