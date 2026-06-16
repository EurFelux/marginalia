// src/main/memory/repository.ts —— 全局记忆 CRUD + 互链边表同步（spec 2026-06-10 §2）。
// 纯函数注入 DB；不触 Electron。边表是派生索引：任何 body 写入路径都过 syncLinks。
import { asc, eq, inArray } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { memories, memoryLinks } from "@main/db/schema";
import { extractLinks } from "@main/memory/links";
import type { MemoryDto, UpdateMemoryInput } from "@shared/memory";

type MemoryRow = typeof memories.$inferSelect;

export interface MemoryNeighbor {
  slug: string;
  title: string;
  description: string;
}

/** readMemory 工具视图：正文 + 出链/入链 + 悬空链接（spec §4）。 */
export interface MemoryDetail extends MemoryRow {
  outgoing: MemoryNeighbor[];
  incoming: MemoryNeighbor[];
  danglingLinks: string[];
}

export interface CreateMemoryInput {
  slug: string;
  title: string;
  description: string;
  body: string;
}

function syncLinks(tx: Omit<DB, "$client">, fromId: string, body: string): void {
  tx.delete(memoryLinks).where(eq(memoryLinks.fromId, fromId)).run();
  const slugs = extractLinks(body);
  if (slugs.length === 0) return;
  const targets = tx
    .select({ id: memories.id })
    .from(memories)
    .where(inArray(memories.slug, slugs))
    .all();
  if (targets.length === 0) return;
  tx.insert(memoryLinks)
    .values(targets.map((t) => ({ fromId, toId: t.id })))
    .run();
}

export function createMemory(db: DB, input: CreateMemoryInput): MemoryRow {
  return db.transaction((tx) => {
    const row = tx.insert(memories).values(input).returning().get();
    syncLinks(tx, row.id, row.body);
    return row;
  });
}

export function updateMemoryById(db: DB, patch: UpdateMemoryInput): MemoryRow | null {
  return db.transaction((tx) => {
    const row = tx
      .update(memories)
      .set({
        ...(patch.title !== undefined ? { title: patch.title } : {}),
        ...(patch.description !== undefined ? { description: patch.description } : {}),
        ...(patch.body !== undefined ? { body: patch.body } : {}),
        updatedAt: Date.now(),
      })
      .where(eq(memories.id, patch.id))
      .returning()
      .get();
    if (!row) return null;
    if (patch.body !== undefined) syncLinks(tx, row.id, row.body);
    return row;
  });
}

export function deleteMemoryById(db: DB, id: string): void {
  db.delete(memories).where(eq(memories.id, id)).run(); // 边表 CASCADE 清边
}

export function getMemoryById(db: DB, id: string): MemoryRow | null {
  return db.select().from(memories).where(eq(memories.id, id)).get() ?? null;
}

export function getMemoryBySlug(db: DB, slug: string): MemoryDetail | null {
  const row = db.select().from(memories).where(eq(memories.slug, slug)).get();
  if (!row) return null;
  const linked = extractLinks(row.body);
  const outgoingRows =
    linked.length > 0
      ? db
          .select({ slug: memories.slug, title: memories.title, description: memories.description })
          .from(memories)
          .where(inArray(memories.slug, linked))
          .all()
      : [];
  // 按 body 中 [[slug]] 出现序重建 outgoing，避免 inArray 查询的不确定顺序（LLM 按行文顺序消费）。
  const slugToRow = new Map(outgoingRows.map((r) => [r.slug, r]));
  const outgoing = linked.filter((s) => slugToRow.has(s)).map((s) => slugToRow.get(s)!);
  const existing = new Set(outgoingRows.map((o) => o.slug));
  const incoming = db
    .select({ slug: memories.slug, title: memories.title, description: memories.description })
    .from(memoryLinks)
    .innerJoin(memories, eq(memoryLinks.fromId, memories.id))
    .where(eq(memoryLinks.toId, row.id))
    .all();
  return {
    ...row,
    outgoing,
    incoming,
    danglingLinks: linked.filter((s) => !existing.has(s)),
  };
}

/** 确定性排序 (createdAt, id)——索引渲染与管理列表共用（spec §5 抖动纪律）。 */
export function listMemories(db: DB): MemoryDto[] {
  return db
    .select({
      id: memories.id,
      slug: memories.slug,
      title: memories.title,
      description: memories.description,
      body: memories.body,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .orderBy(asc(memories.createdAt), asc(memories.id))
    .all();
}
