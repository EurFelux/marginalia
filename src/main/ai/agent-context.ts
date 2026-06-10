// src/main/ai/agent-context.ts —— system prompt 中间三层（instructions + SOUL + 记忆索引）的
// 渲染与会话快照冻结（spec 2026-06-10 §3/§5）。
// 快照不持久化：进程内 Map，app 重启即重渲染（provider 缓存 TTL 早过期，语义零损失）。
import type { DB } from "@main/db/client";
import { getPreference } from "@main/preferences/repository";
import { listMemories } from "@main/memory/repository";
import { DEFAULT_SOUL } from "@shared/preferences";

const snapshots = new Map<string, string>();

/** 纯渲染（测试直测）：instructions 段 + SOUL 段 + 记忆索引段；空段整体省略。 */
export function renderAgentContext(db: DB): string {
  const sections: string[] = [];

  const instructions = getPreference(db, "instructions");
  if (instructions && instructions.trim().length > 0) {
    sections.push(`## Reader instructions\n\n${instructions.trim()}`);
  }

  const soul = getPreference(db, "soul") ?? DEFAULT_SOUL;
  sections.push(`## Who you are\n\nYour name is ${soul.name}. ${soul.persona}`.trimEnd());

  const memoryEnabled = getPreference(db, "memoryEnabled") ?? true;
  if (memoryEnabled) {
    const all = listMemories(db); // 已按 (createdAt, id) 确定性排序
    if (all.length > 0) {
      const lines = all.map((m) => `- [${m.slug}] ${m.title} — ${m.description}`);
      sections.push(`## Memory index\n\n${lines.join("\n")}`);
    }
  }

  return sections.join("\n\n");
}

/** 会话快照：首轮渲染并冻结，本会话每轮逐字复用（保 provider prompt cache 前缀稳定）。 */
export function getAgentContext(db: DB, conversationId: string): string {
  const cached = snapshots.get(conversationId);
  if (cached !== undefined) return cached;
  const rendered = renderAgentContext(db);
  snapshots.set(conversationId, rendered);
  return rendered;
}

/** SOUL / instructions 变更时调用：清空全部快照，下一轮立即生效（spec §5 失效细则）。 */
export function invalidateAllAgentContexts(): void {
  snapshots.clear();
}

/** 会话删除时清理对应快照（防泄漏）。 */
export function dropAgentContext(conversationId: string): void {
  snapshots.delete(conversationId);
}
