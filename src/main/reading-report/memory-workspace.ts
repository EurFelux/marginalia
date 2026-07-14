import { tool, type ToolSet } from "ai";
import { z } from "zod";
import type { DB } from "@main/db/client";
import { extractLinks } from "@main/memory/links";
import { listMemories } from "@main/memory/repository";
import { getPreference } from "@main/preferences/repository";
import { memorySlug } from "@shared/memory";

interface WorkspaceMemory {
  id: string | null;
  slug: string;
  title: string;
  description: string;
  body: string;
  updatedAt: number | null;
}

export type ReadingReportMemoryMutation =
  | {
      kind: "create";
      slug: string;
      title: string;
      description: string;
      body: string;
    }
  | {
      kind: "update";
      id: string;
      slug: string;
      expectedUpdatedAt: number;
      title: string;
      description: string;
      body: string;
    };

export interface ReadingReportMemoryWorkspace {
  tools: ToolSet;
  mutations: () => ReadingReportMemoryMutation[];
}

function neighbor(memory: WorkspaceMemory) {
  return {
    slug: memory.slug,
    title: memory.title,
    description: memory.description,
  };
}

export function createReadingReportMemoryWorkspace(db: DB): ReadingReportMemoryWorkspace {
  if (!(getPreference(db, "memoryEnabled") ?? true)) {
    return { tools: {}, mutations: () => [] };
  }

  const baseBySlug = new Map<string, WorkspaceMemory>();
  for (const memory of listMemories(db)) {
    baseBySlug.set(memory.slug, {
      id: memory.id,
      slug: memory.slug,
      title: memory.title,
      description: memory.description,
      body: memory.body,
      updatedAt: memory.updatedAt,
    });
  }
  const currentBySlug = new Map(
    [...baseBySlug].map(([slug, memory]) => [slug, { ...memory }] as const),
  );
  const dirtySlugs = new Set<string>();

  const tools: ToolSet = {
    readMemory: tool({
      description:
        "Read one full long-term memory from the index. Reads include changes staged during this report generation.",
      inputSchema: z.object({ slug: memorySlug }),
      execute: async ({ slug }) => {
        const memory = currentBySlug.get(slug);
        if (!memory)
          return { found: false as const, slug, hint: "no such memory; check the index" };
        const linked = extractLinks(memory.body);
        return {
          found: true as const,
          slug: memory.slug,
          title: memory.title,
          description: memory.description,
          body: memory.body,
          outgoing: linked
            .map((linkedSlug) => currentBySlug.get(linkedSlug))
            .filter((candidate): candidate is WorkspaceMemory => candidate !== undefined)
            .map(neighbor),
          incoming: [...currentBySlug.values()]
            .filter((candidate) => extractLinks(candidate.body).includes(slug))
            .map(neighbor),
          danglingLinks: linked.filter((linkedSlug) => !currentBySlug.has(linkedSlug)),
        };
      },
    }),
    saveMemory: tool({
      description:
        "Stage a new durable memory about the reader: a lasting preference, viewpoint, recurring concept, framework, correction, or cross-book connection. Not for book content, the complete report, or a one-off thought. The memory is saved only if the report succeeds.",
      inputSchema: z.object({
        slug: memorySlug,
        title: z.string().min(1),
        description: z.string().min(1),
        body: z.string().min(1),
      }),
      execute: async ({ slug, title, description, body }) => {
        if (currentBySlug.has(slug)) {
          return {
            saved: false as const,
            slug,
            hint: "memory already exists; read and update it instead",
          };
        }
        currentBySlug.set(slug, {
          id: null,
          slug,
          title,
          description,
          body,
          updatedAt: null,
        });
        dirtySlugs.add(slug);
        return { saved: true as const, slug };
      },
    }),
    updateMemory: tool({
      description:
        "Stage an update to an existing durable memory. Prefer this over creating near-duplicates. The final values are saved only if the report succeeds.",
      inputSchema: z.object({
        slug: memorySlug,
        title: z.string().min(1).optional(),
        description: z.string().min(1).optional(),
        body: z.string().min(1).optional(),
      }),
      execute: async ({ slug, title, description, body }) => {
        const existing = currentBySlug.get(slug);
        if (!existing) return { updated: false as const, slug, hint: "no such memory" };
        currentBySlug.set(slug, {
          ...existing,
          ...(title !== undefined ? { title } : {}),
          ...(description !== undefined ? { description } : {}),
          ...(body !== undefined ? { body } : {}),
        });
        dirtySlugs.add(slug);
        return { updated: true as const, slug };
      },
    }),
  };

  return {
    tools,
    mutations: () =>
      [...dirtySlugs].sort().flatMap((slug): ReadingReportMemoryMutation[] => {
        const current = currentBySlug.get(slug)!;
        const base = baseBySlug.get(slug);
        if (!base) {
          return [
            {
              kind: "create",
              slug,
              title: current.title,
              description: current.description,
              body: current.body,
            },
          ];
        }
        if (
          current.title === base.title &&
          current.description === base.description &&
          current.body === base.body
        ) {
          return [];
        }
        return [
          {
            kind: "update",
            id: base.id!,
            slug,
            expectedUpdatedAt: base.updatedAt!,
            title: current.title,
            description: current.description,
            body: current.body,
          },
        ];
      }),
  };
}
