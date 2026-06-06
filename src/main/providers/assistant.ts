import { asc, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { assistants, providers } from "@main/db/schema";
import type { AssistantDto, UpdateAssistantInput } from "@shared/assistant";

export const DEFAULT_ASSISTANT_NAME = "Default Assistant";
export const DEFAULT_SYSTEM_PROMPT =
  "You are a reading assistant embedded in an e-book reader. The user is reading a book and may select text to ask about it. Ground your answers in the provided selection, surrounding paragraphs, and chapter summary. When you need more of the original text, use the available reading tools. Answer concisely.";

type AssistantRow = typeof assistants.$inferSelect;

function toDto(row: AssistantRow): AssistantDto {
  return {
    id: row.id,
    name: row.name,
    systemPrompt: row.systemPrompt ?? null,
    providerId: row.providerId ?? null,
    model: row.model ?? null,
  };
}

/** 取默认 Assistant；库中无则懒创建一行（Phase 1 仅一个）。 */
export function getDefaultAssistant(db: DB): AssistantDto {
  // Phase 1 仅一行；按 createdAt 取最早一行即「默认」（多 Assistant 后此处再细化）。
  const existing = db.select().from(assistants).orderBy(asc(assistants.createdAt)).limit(1).get();
  if (existing) return toDto(existing);
  const seeded = db
    .insert(assistants)
    .values({ name: DEFAULT_ASSISTANT_NAME, systemPrompt: DEFAULT_SYSTEM_PROMPT })
    .returning()
    .get();
  return toDto(seeded);
}

/** 更新默认 Assistant 的可编辑字段（仅传入的字段被更新）。 */
export function updateDefaultAssistant(db: DB, patch: UpdateAssistantInput): AssistantDto {
  // 有意「ensure-then-update」：默认 Assistant 概念上恒存在，首次经写入路径触达时一并惰性物化。
  const current = getDefaultAssistant(db);
  if (patch.providerId != null) {
    const exists = db
      .select({ id: providers.id })
      .from(providers)
      .where(eq(providers.id, patch.providerId))
      .get();
    if (!exists) throw new Error(`assistant update: provider ${patch.providerId} not found`);
  }
  const row = db
    .update(assistants)
    .set({
      ...(patch.name !== undefined ? { name: patch.name } : {}),
      ...(patch.systemPrompt !== undefined ? { systemPrompt: patch.systemPrompt } : {}),
      ...(patch.providerId !== undefined ? { providerId: patch.providerId } : {}),
      ...(patch.model !== undefined ? { model: patch.model } : {}),
    })
    .where(eq(assistants.id, current.id))
    .returning()
    .get();
  if (!row) throw new Error("updateDefaultAssistant: row missing after update");
  return toDto(row);
}
