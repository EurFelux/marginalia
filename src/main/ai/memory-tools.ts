// src/main/ai/memory-tools.ts —— Lia 的记忆/SOUL 写工具（spec 2026-06-10 §4）。
// 失败一律转结构化工具结果（模型自纠），不抛 IPC 错误；软失败留 log.warn。
import { tool, type Tool } from "ai";
import { z } from "zod";
import type { DB } from "@main/db/client";
import { createLogger } from "@main/logger";
import {
  createMemory,
  deleteMemoryById,
  getMemoryBySlug,
  updateMemoryById,
} from "@main/memory/repository";
import { getPreference, setPreference } from "@main/preferences/repository";
import { invalidateAllAgentContexts } from "@main/ai/agent-context";
import { memorySlug } from "@shared/memory";
import { DEFAULT_SOUL } from "@shared/preferences";

const log = createLogger("memory");

export interface MemoryToolsDeps {
  db: DB;
  /** 当前会话归属书；saveMemory 自动填 sourceBookId（溯源标签，非归属）。 */
  bookId: string | null;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type MemoryTools = {
  updateSoul: Tool<any, any>;
  readMemory?: Tool<any, any>;
  saveMemory?: Tool<any, any>;
  updateMemory?: Tool<any, any>;
  deleteMemory?: Tool<any, any>;
};

export function createMemoryTools(deps: MemoryToolsDeps): MemoryTools {
  const { db, bookId } = deps;

  const updateSoul = tool({
    description:
      "Update your own persona (SOUL). Use when the reader renames you or asks you to change how you speak/behave long-term. Cannot touch reader instructions.",
    inputSchema: z.object({
      name: z.string().min(1).optional(),
      persona: z.string().min(1).optional(),
    }),
    execute: async ({ name, persona }) => {
      try {
        const current = getPreference(db, "soul") ?? DEFAULT_SOUL;
        const next = { name: name ?? current.name, persona: persona ?? current.persona };
        setPreference(db, "soul", next);
        invalidateAllAgentContexts();
        return { updated: true as const, soul: next };
      } catch (err) {
        log.warn("updateSoul failed", err);
        return { updated: false as const, error: err instanceof Error ? err.message : String(err) };
      }
    },
  });

  const memoryEnabled = getPreference(db, "memoryEnabled") ?? true;
  if (!memoryEnabled) return { updateSoul };

  return {
    updateSoul,
    readMemory: tool({
      description:
        "Read the full body of one memory from your global memory (the index above only has title + description). Returns linked memories both ways.",
      inputSchema: z.object({ slug: memorySlug }),
      execute: async ({ slug }) => {
        const m = getMemoryBySlug(db, slug);
        if (!m) return { found: false as const, slug, hint: "no such memory; check the index" };
        return {
          found: true as const,
          slug: m.slug,
          title: m.title,
          description: m.description,
          body: m.body,
          outgoing: m.outgoing,
          incoming: m.incoming,
          danglingLinks: m.danglingLinks,
        };
      },
    }),
    saveMemory: tool({
      description:
        "Save a new long-term memory about the reader (preference, viewpoint, recurring concept, thinking framework, correction). Not for book content or one-off questions. Link related memories with [[slug]] in the body.",
      inputSchema: z.object({
        slug: memorySlug,
        title: z.string().min(1),
        description: z.string().min(1),
        body: z.string().min(1),
      }),
      execute: async ({ slug, title, description, body }) => {
        try {
          createMemory(db, { slug, title, description, body, sourceBookId: bookId });
          return { saved: true as const, slug };
        } catch (err) {
          log.warn("saveMemory failed", err);
          return {
            saved: false as const,
            slug,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),
    updateMemory: tool({
      description:
        "Update an existing memory (merge near-duplicates, refine, enrich). Body is replaced wholesale when provided.",
      inputSchema: z.object({
        slug: memorySlug,
        title: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        body: z.string().min(1).optional(),
      }),
      execute: async ({ slug, title, description, body }) => {
        const existing = getMemoryBySlug(db, slug);
        if (!existing) return { updated: false as const, slug, hint: "no such memory" };
        try {
          updateMemoryById(db, { id: existing.id, title, description, body });
          return { updated: true as const, slug };
        } catch (err) {
          log.warn("updateMemory failed", err);
          return {
            updated: false as const,
            slug,
            error: err instanceof Error ? err.message : String(err),
          };
        }
      },
    }),
    deleteMemory: tool({
      description: "Delete a memory when the reader asks you to forget it or it is obsolete.",
      inputSchema: z.object({ slug: memorySlug }),
      execute: async ({ slug }) => {
        const existing = getMemoryBySlug(db, slug);
        if (!existing) return { deleted: false as const, slug, hint: "no such memory" };
        deleteMemoryById(db, existing.id);
        return { deleted: true as const, slug };
      },
    }),
  };
}
