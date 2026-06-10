# AI 全局记忆 + SOUL 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为应用内 AI（Lia）实现全局持久记忆（memories 表 + slug 互链 + agent 自主读写工具 + 索引常驻注入 + 会话快照冻结）、SOUL/instructions 双层人设，并彻底删除 assistants 表（单一全局 agent）。

**Architecture:** 参照 spec `docs/superpowers/specs/2026-06-10-ai-global-memory-soul-design.md`。无后台提取管线——agent 通过 5 个工具自主读写；system prompt 五层组装（内置模板 + instructions + SOUL + 记忆索引 + 动态层），其中中间三层按会话快照冻结保 prompt cache。所有业务逻辑在主进程纯函数实现（注入 DB），渲染层只做设置页 UI。

**Tech Stack:** Drizzle ORM（迁移）、Zod 4（schema/IPC）、AI SDK v6 `tool()`、vitest（`:memory:` DB）、React 19（设置页）。

**前置：** 开工前用 kanban skill 把 issue #77 挪到 In progress；在 main 最新提交上建分支 `feat/ai-memory-soul`（整个计划在此分支完成，结束后走 finishing-a-development-branch）。

```bash
git checkout -b feat/ai-memory-soul
```

**任务依赖序**：Task 1→3 纯增量（typecheck 始终绿）；Task 8 原子删除 assistants（schema+代码+迁移一次完成，否则编译断）；Task 9–12 渲染层与收尾。

---

### Task 1: schema 新增 memories + memory_links 表与迁移

**Files:**

- Modify: `src/main/db/schema.ts`（在 `preferences` 表定义之前插入）
- Generate: `src/main/db/migrations/<timestamp>_<name>/`（`pnpm db:generate` 产出，勿手编）

- [ ] **Step 1: 在 schema.ts 加两张表**

在 `src/main/db/schema.ts` 的 `preferences` 表定义前插入（沿用文件内 `pkUuid()`/`nowMs()` 惯例）：

```typescript
// AI 全局记忆（spec 2026-06-10-ai-global-memory-soul-design §2.1）。
// slug 是 AI 侧统一标识符（工具入参 / [[互链]] / 索引展示），创建后不可改；uuid 主键仅内部用。
export const memories = sqliteTable(
  "memories",
  {
    id: pkUuid(),
    slug: text("slug").notNull().unique(),
    title: text("title").notNull(),
    description: text("description").notNull(), // 一行摘要：常驻注入 system prompt 的就是它
    body: text("body").notNull(), // 详细正文：readMemory 按需取；可含 [[slug]] 互链
    // 「在哪记下的」溯源标签（非归属）；删书 SET NULL，记忆保留（全局事实不随书消失）。
    sourceBookId: text("source_book_id").references(() => books.id, { onDelete: "set null" }),
    createdAt: nowMs(),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [index("memories_source_book_id_idx").on(t.sourceBookId)],
);

// 互链边表（派生索引；真相源是 memories.body 里的 [[slug]]，坏了可全量重建）。
// 悬空链接不入表；删除记忆 CASCADE 清边（入链方 body 文本不动，自然转悬空）。
export const memoryLinks = sqliteTable(
  "memory_links",
  {
    fromId: text("from_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
    toId: text("to_id")
      .notNull()
      .references(() => memories.id, { onDelete: "cascade" }),
  },
  (t) => [primaryKey({ columns: [t.fromId, t.toId] }), index("memory_links_to_id_idx").on(t.toId)],
);
```

并在文件头部 import 里补 `primaryKey`（来自 `drizzle-orm/sqlite-core`）。

- [ ] **Step 2: 生成迁移**

Run: `pnpm db:generate`
Expected: 新增 `src/main/db/migrations/<timestamp>_<name>/` 目录，`migration.sql` 含 `CREATE TABLE memories` 与 `CREATE TABLE memory_links`。

- [ ] **Step 3: 全量测试验证迁移可跑**

Run: `pnpm test`
Expected: 全部 PASS（既有测试 `freshDb()` 跑全迁移，新迁移语法错会在此暴露）。

- [ ] **Step 4: Commit**

```bash
git add src/main/db/schema.ts src/main/db/migrations
git commit -m "feat(memory): add memories and memory_links tables"
```

---

### Task 2: preferences 注册 4 个新 key（chatModel / memoryEnabled / soul / instructions）

**Files:**

- Modify: `src/shared/preferences.ts`
- Modify: `src/main/ipc/preferences-handlers.ts:10-41`（switch 补 4 个 case）
- Test: `src/main/preferences/preferences.test.ts`（已有文件，补用例；若不存在则查 `src/main/preferences/` 下既有测试文件名）

- [ ] **Step 1: 写失败测试**

在 preferences 测试文件中追加：

```typescript
it("stores and reads chatModel / memoryEnabled / soul / instructions", () => {
  const db = freshDb();
  setPreference(db, "chatModel", { providerId: "p1", model: "m1" });
  expect(getPreference(db, "chatModel")).toEqual({ providerId: "p1", model: "m1" });

  setPreference(db, "memoryEnabled", false);
  expect(getPreference(db, "memoryEnabled")).toBe(false);

  setPreference(db, "soul", { name: "Lia", persona: "warm companion" });
  expect(getPreference(db, "soul")).toEqual({ name: "Lia", persona: "warm companion" });

  setPreference(db, "instructions", "answer briefly");
  expect(getPreference(db, "instructions")).toBe("answer briefly");
});
```

注意：该测试文件如有「setPreferenceInput 与 PREFERENCE_SCHEMAS key 同步」的既有校验用例，新 key 注册后它会自动覆盖判别 union 的同步性。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/preferences`
Expected: FAIL（chatModel 等 key 不在 PREFERENCE_SCHEMAS，类型错误/解析失败）

- [ ] **Step 3: 注册 schema**

`src/shared/preferences.ts`，在 `summaryModelSchema` 定义后追加：

```typescript
/** 聊天模型（接替 assistants 表配置；spec 2026-06-10 §2.2）：语义同 summaryModel——显式对，未存 = 未配置。 */
export const chatModelSchema = z.object({
  providerId: z.string().min(1),
  model: z.string().min(1),
});
export type ChatModel = z.infer<typeof chatModelSchema>;

/** agent 自我设定（SOUL）：name 独立字段（UI 显示用），persona 自由 markdown。用户与 AI 都可写。 */
export const soulSchema = z.object({
  name: z.string().min(1),
  persona: z.string(),
});
export type Soul = z.infer<typeof soulSchema>;

/** SOUL 出厂值：默认名 Lia（margina-lia 词尾）；persona 简短留白，供用户与 Lia 共同演化。 */
export const DEFAULT_SOUL: Soul = {
  name: "Lia",
  persona:
    "You are a warm, curious, and thoughtful reading companion. You genuinely care about how your reader thinks and grows. Keep your voice gentle and concise; let personality come through naturally rather than performing it.",
};
```

`PREFERENCE_SCHEMAS` 追加四行：

```typescript
  chatModel: chatModelSchema,
  memoryEnabled: z.boolean(),
  soul: soulSchema,
  instructions: z.string(),
```

`setPreferenceInput` 判别 union 追加四条 arm：

```typescript
  z.object({ key: z.literal("chatModel"), value: chatModelSchema }),
  z.object({ key: z.literal("memoryEnabled"), value: z.boolean() }),
  z.object({ key: z.literal("soul"), value: soulSchema }),
  z.object({ key: z.literal("instructions"), value: z.string() }),
```

- [ ] **Step 4: 补 preferences-handlers switch case**

`src/main/ipc/preferences-handlers.ts` 的 switch 内（`stepLimit` case 之后）追加——⚠️ 漏补会静默吞写（never 守卫此时会编译报错）：

```typescript
      case "chatModel":
        return setPreference(getDb(), input.key, input.value);
      case "memoryEnabled":
        return setPreference(getDb(), input.key, input.value);
      case "soul":
        return setPreference(getDb(), input.key, input.value);
      case "instructions":
        return setPreference(getDb(), input.key, input.value);
```

（Task 7 会给 soul/instructions 两个 case 追加快照失效调用，此处先落基础形态。）

- [ ] **Step 5: 跑测试确认通过 + typecheck**

Run: `pnpm test src/main/preferences && pnpm typecheck`
Expected: PASS

- [ ] **Step 6: Commit**

```bash
git add src/shared/preferences.ts src/main/ipc/preferences-handlers.ts src/main/preferences
git commit -m "feat(memory): register chatModel/memoryEnabled/soul/instructions preferences"
```

---

### Task 3: memories repository + extractLinks 互链解析

**Files:**

- Create: `src/main/memory/links.ts`（纯函数）
- Create: `src/main/memory/repository.ts`
- Create: `src/shared/memory.ts`（MemoryDto + Zod 输入）
- Test: `src/main/memory/links.test.ts`、`src/main/memory/repository.test.ts`

- [ ] **Step 1: 写 extractLinks 失败测试**

`src/main/memory/links.test.ts`：

```typescript
import { describe, expect, it } from "vitest";
import { extractLinks } from "@main/memory/links";

describe("extractLinks", () => {
  it("extracts [[slug]] occurrences in order, deduped", () => {
    expect(extractLinks("see [[a-b]] and [[c]] and [[a-b]] again")).toEqual(["a-b", "c"]);
  });
  it("ignores malformed brackets and illegal slugs", () => {
    expect(extractLinks("[[]] [[ x ]] [[UPPER]] [[has_underscore]] [single] [[ok-1]]")).toEqual([
      "ok-1",
    ]);
  });
  it("returns empty for body without links", () => {
    expect(extractLinks("plain text")).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/memory/links.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 extractLinks**

`src/main/memory/links.ts`：

```typescript
// 互链解析（spec 2026-06-10 §2.1.1）：body 内 [[slug]] 是真相源，边表仅派生。
// slug 形状与 shared/memory.ts 的 memorySlug 一致：英文 kebab-case。
const LINK_RE = /\[\[([a-z0-9]+(?:-[a-z0-9]+)*)\]\]/g;

/** 解析 body 中的 [[slug]]，按出现序去重。非法形状（大写/下划线/空白）不命中。 */
export function extractLinks(body: string): string[] {
  const seen = new Set<string>();
  for (const m of body.matchAll(LINK_RE)) {
    seen.add(m[1]);
  }
  return [...seen];
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/memory/links.test.ts`
Expected: PASS

- [ ] **Step 5: 定义 shared/memory.ts**

```typescript
import { z } from "zod";

/** AI 侧统一标识符：英文 kebab-case 短名（spec 2026-06-10 §2.1）。 */
export const memorySlug = z.string().regex(/^[a-z0-9]+(-[a-z0-9]+)*$/, "kebab-case slug expected");

/** 管理面板用的记忆视图（含来源书名投影）。 */
export interface MemoryDto {
  id: string;
  slug: string;
  title: string;
  description: string;
  body: string;
  sourceBookId: string | null;
  sourceBookTitle: string | null;
  createdAt: number;
  updatedAt: number;
}

/** memories:update 入参（管理面板按 id 操作；slug 不可改）。 */
export const updateMemoryInput = z.object({
  id: z.string().min(1),
  title: z.string().min(1).optional(),
  description: z.string().min(1).optional(),
  body: z.string().min(1).optional(),
});
export type UpdateMemoryInput = z.infer<typeof updateMemoryInput>;

/** memories:delete 入参。 */
export const deleteMemoryInput = z.object({ id: z.string().min(1) });
export type DeleteMemoryInput = z.infer<typeof deleteMemoryInput>;
```

- [ ] **Step 6: 写 repository 失败测试**

`src/main/memory/repository.test.ts`：

```typescript
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { books } from "@main/db/schema";
import {
  createMemory,
  deleteMemoryById,
  getMemoryBySlug,
  listMemories,
  updateMemoryById,
} from "@main/memory/repository";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("memories repository", () => {
  it("creates and reads a memory by slug", () => {
    const db = freshDb();
    const m = createMemory(db, {
      slug: "econ-framework",
      title: "经济学框架",
      description: "用经济学框架理解社会问题",
      body: "详细正文",
      sourceBookId: null,
    });
    expect(m.slug).toBe("econ-framework");
    expect(getMemoryBySlug(db, "econ-framework")?.id).toBe(m.id);
  });

  it("rejects duplicate slug", () => {
    const db = freshDb();
    createMemory(db, { slug: "a", title: "t", description: "d", body: "b", sourceBookId: null });
    expect(() =>
      createMemory(db, {
        slug: "a",
        title: "t2",
        description: "d2",
        body: "b2",
        sourceBookId: null,
      }),
    ).toThrow();
  });

  it("syncs memory_links from body, ignoring dangling slugs", () => {
    const db = freshDb();
    createMemory(db, {
      slug: "target",
      title: "t",
      description: "d",
      body: "b",
      sourceBookId: null,
    });
    const m = createMemory(db, {
      slug: "source",
      title: "t",
      description: "d",
      body: "links [[target]] and [[not-yet]]",
      sourceBookId: null,
    });
    const read = getMemoryBySlug(db, "source");
    expect(read?.outgoing.map((o) => o.slug)).toEqual(["target"]);
    expect(read?.danglingLinks).toEqual(["not-yet"]);
    const target = getMemoryBySlug(db, "target");
    expect(target?.incoming.map((i) => i.slug)).toEqual(["source"]);
    expect(m.id).toBeTruthy();
  });

  it("re-syncs links on body update and clears edges on delete", () => {
    const db = freshDb();
    const a = createMemory(db, {
      slug: "a",
      title: "t",
      description: "d",
      body: "b",
      sourceBookId: null,
    });
    const b = createMemory(db, {
      slug: "b",
      title: "t",
      description: "d",
      body: "see [[a]]",
      sourceBookId: null,
    });
    updateMemoryById(db, { id: b.id, body: "no links now" });
    expect(getMemoryBySlug(db, "a")?.incoming).toEqual([]);
    updateMemoryById(db, { id: b.id, body: "back to [[a]]" });
    deleteMemoryById(db, a.id);
    // a 删除后：b 的 body 文本不动，[[a]] 转为悬空
    expect(getMemoryBySlug(db, "b")?.danglingLinks).toEqual(["a"]);
  });

  it("keeps memory on book deletion (sourceBookId SET NULL)", () => {
    const db = freshDb();
    db.insert(books).values({ id: "book-1", title: "Book One" }).run();
    createMemory(db, {
      slug: "m",
      title: "t",
      description: "d",
      body: "b",
      sourceBookId: "book-1",
    });
    db.delete(books).where(eq(books.id, "book-1")).run();
    expect(listMemories(db)[0].sourceBookId).toBeNull();
  });

  it("lists memories with stable order (createdAt, id)", () => {
    const db = freshDb();
    createMemory(db, { slug: "m1", title: "t1", description: "d1", body: "b", sourceBookId: null });
    createMemory(db, { slug: "m2", title: "t2", description: "d2", body: "b", sourceBookId: null });
    expect(listMemories(db).map((m) => m.slug)).toEqual(["m1", "m2"]);
  });
});
```

（书删除用例写成实际可跑的形态：`import { eq } from "drizzle-orm"` 后 `db.delete(books).where(eq(books.id, "book-1")).run()`。）

- [ ] **Step 7: 实现 repository**

`src/main/memory/repository.ts`：

```typescript
// src/main/memory/repository.ts —— 全局记忆 CRUD + 互链边表同步（spec 2026-06-10 §2）。
// 纯函数注入 DB；不触 Electron。边表是派生索引：任何 body 写入路径都过 syncLinks。
import { asc, eq, inArray } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { books, memories, memoryLinks } from "@main/db/schema";
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
  sourceBookId: string | null;
}

function syncLinks(db: DB, fromId: string, body: string): void {
  db.delete(memoryLinks).where(eq(memoryLinks.fromId, fromId)).run();
  const slugs = extractLinks(body);
  if (slugs.length === 0) return;
  const targets = db
    .select({ id: memories.id })
    .from(memories)
    .where(inArray(memories.slug, slugs))
    .all();
  if (targets.length === 0) return;
  db.insert(memoryLinks)
    .values(targets.map((t) => ({ fromId, toId: t.id })))
    .run();
}

export function createMemory(db: DB, input: CreateMemoryInput): MemoryRow {
  const row = db.insert(memories).values(input).returning().get();
  syncLinks(db, row.id, row.body);
  return row;
}

export function updateMemoryById(db: DB, patch: UpdateMemoryInput): MemoryRow | null {
  const row = db
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
  if (patch.body !== undefined) syncLinks(db, row.id, row.body);
  return row;
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
  const existing = new Set(outgoingRows.map((o) => o.slug));
  const incoming = db
    .select({ slug: memories.slug, title: memories.title, description: memories.description })
    .from(memoryLinks)
    .innerJoin(memories, eq(memoryLinks.fromId, memories.id))
    .where(eq(memoryLinks.toId, row.id))
    .all();
  return {
    ...row,
    outgoing: outgoingRows,
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
      sourceBookId: memories.sourceBookId,
      sourceBookTitle: books.title,
      createdAt: memories.createdAt,
      updatedAt: memories.updatedAt,
    })
    .from(memories)
    .leftJoin(books, eq(memories.sourceBookId, books.id))
    .orderBy(asc(memories.createdAt), asc(memories.id))
    .all()
    .map((r) => ({ ...r, sourceBookTitle: r.sourceBookTitle ?? null }));
}
```

- [ ] **Step 8: 跑测试确认通过 + typecheck**

Run: `pnpm test src/main/memory && pnpm typecheck`
Expected: PASS

- [ ] **Step 9: Commit**

```bash
git add src/main/memory src/shared/memory.ts
git commit -m "feat(memory): memories repository with [[slug]] link extraction and edge sync"
```

---

### Task 4: agent-context——五层中间三层渲染 + 会话快照冻结

**Files:**

- Create: `src/main/ai/agent-context.ts`
- Test: `src/main/ai/agent-context.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/ai/agent-context.test.ts`：

```typescript
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { setPreference } from "@main/preferences/repository";
import { createMemory } from "@main/memory/repository";
import {
  dropAgentContext,
  getAgentContext,
  invalidateAllAgentContexts,
  renderAgentContext,
} from "@main/ai/agent-context";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

beforeEach(() => invalidateAllAgentContexts());

describe("renderAgentContext", () => {
  it("renders default soul when nothing stored; omits instructions and memory sections when empty", () => {
    const db = freshDb();
    const text = renderAgentContext(db);
    expect(text).toContain("Lia");
    expect(text).not.toContain("## Reader instructions");
    expect(text).not.toContain("## Memory index");
  });

  it("renders instructions and memory index lines in (createdAt, id) order", () => {
    const db = freshDb();
    setPreference(db, "instructions", "be brief");
    createMemory(db, { slug: "m1", title: "T1", description: "D1", body: "b", sourceBookId: null });
    createMemory(db, { slug: "m2", title: "T2", description: "D2", body: "b", sourceBookId: null });
    const text = renderAgentContext(db);
    expect(text).toContain("be brief");
    expect(text.indexOf("[m1]")).toBeLessThan(text.indexOf("[m2]"));
    expect(text).toContain("[m1] T1 — D1");
  });

  it("omits memory index when memoryEnabled=false (soul still present)", () => {
    const db = freshDb();
    setPreference(db, "memoryEnabled", false);
    createMemory(db, { slug: "m1", title: "T1", description: "D1", body: "b", sourceBookId: null });
    const text = renderAgentContext(db);
    expect(text).not.toContain("[m1]");
    expect(text).toContain("Lia");
  });
});

describe("session snapshot freeze", () => {
  it("returns identical text within a conversation even after new memory", () => {
    const db = freshDb();
    const first = getAgentContext(db, "conv-1");
    createMemory(db, { slug: "new", title: "N", description: "D", body: "b", sourceBookId: null });
    expect(getAgentContext(db, "conv-1")).toBe(first); // 冻结：逐字一致
    expect(getAgentContext(db, "conv-2")).toContain("[new]"); // 新会话见新记忆
  });

  it("invalidateAllAgentContexts forces re-render (soul/instructions change semantics)", () => {
    const db = freshDb();
    const first = getAgentContext(db, "conv-1");
    setPreference(db, "soul", { name: "Mia", persona: "p" });
    invalidateAllAgentContexts();
    const second = getAgentContext(db, "conv-1");
    expect(second).not.toBe(first);
    expect(second).toContain("Mia");
  });

  it("dropAgentContext clears a single conversation snapshot", () => {
    const db = freshDb();
    getAgentContext(db, "conv-1");
    dropAgentContext("conv-1");
    createMemory(db, { slug: "late", title: "L", description: "D", body: "b", sourceBookId: null });
    expect(getAgentContext(db, "conv-1")).toContain("[late]");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/agent-context.test.ts`
Expected: FAIL（模块不存在）

- [ ] **Step 3: 实现 agent-context**

`src/main/ai/agent-context.ts`：

```typescript
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

/** 会话快照：首轮渲染并冻结，本会话每轮逐字复用（保 prompt cache 前缀稳定）。 */
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/ai/agent-context.test.ts`
Expected: PASS

- [ ] **Step 5: 接线快照失效与清理**

① `src/main/ipc/preferences-handlers.ts`：`soul` 与 `instructions` 两个 case 改为（import `invalidateAllAgentContexts`）：

```typescript
      case "soul": {
        invalidateAllAgentContexts();
        return setPreference(getDb(), input.key, input.value);
      }
      case "instructions": {
        invalidateAllAgentContexts();
        return setPreference(getDb(), input.key, input.value);
      }
```

② `src/main/chat/conversations.ts` 的 `deleteConversation` 加一行（import `dropAgentContext`）：

```typescript
export function deleteConversation(db: DB, id: string): void {
  db.delete(conversations).where(eq(conversations.id, id)).run();
  dropAgentContext(id);
}
```

- [ ] **Step 6: 全量验证**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

- [ ] **Step 7: Commit**

```bash
git add src/main/ai/agent-context.ts src/main/ai/agent-context.test.ts src/main/ipc/preferences-handlers.ts src/main/chat/conversations.ts
git commit -m "feat(memory): agent context rendering with per-conversation snapshot freeze"
```

---

### Task 5: 记忆 + SOUL 工具（5 个）

**Files:**

- Create: `src/main/ai/memory-tools.ts`
- Test: `src/main/ai/memory-tools.test.ts`
- Modify: `src/main/ai/stream-assistant.ts:57-58`（工具合并注册）

- [ ] **Step 1: 写失败测试**

`src/main/ai/memory-tools.test.ts`（工具 `execute` 直接调用即可测，无需跑模型）：

```typescript
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { getPreference, setPreference } from "@main/preferences/repository";
import { createMemory, getMemoryBySlug } from "@main/memory/repository";
import { createMemoryTools } from "@main/ai/memory-tools";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("createMemoryTools", () => {
  it("omits memory tools when memoryEnabled=false but always exposes updateSoul", () => {
    const db = freshDb();
    setPreference(db, "memoryEnabled", false);
    const tools = createMemoryTools({ db, bookId: "b1" });
    expect(Object.keys(tools)).toEqual(["updateSoul"]);
  });

  it("saveMemory fills sourceBookId from deps and returns the slug", async () => {
    const db = freshDb();
    const tools = createMemoryTools({ db, bookId: null });
    const out = await tools.saveMemory!.execute!(
      { slug: "econ", title: "T", description: "D", body: "B" },
      {} as never,
    );
    expect(out).toMatchObject({ saved: true, slug: "econ" });
    expect(getMemoryBySlug(db, "econ")).not.toBeNull();
  });

  it("saveMemory reports slug conflict as tool result (model self-corrects)", async () => {
    const db = freshDb();
    createMemory(db, { slug: "dup", title: "t", description: "d", body: "b", sourceBookId: null });
    const tools = createMemoryTools({ db, bookId: null });
    const out = await tools.saveMemory!.execute!(
      { slug: "dup", title: "T", description: "D", body: "B" },
      {} as never,
    );
    expect(out).toMatchObject({ saved: false });
  });

  it("readMemory returns body with outgoing/incoming/dangling; unknown slug returns notFound", async () => {
    const db = freshDb();
    createMemory(db, {
      slug: "a",
      title: "A",
      description: "d",
      body: "see [[ghost]]",
      sourceBookId: null,
    });
    const tools = createMemoryTools({ db, bookId: null });
    const ok = await tools.readMemory!.execute!({ slug: "a" }, {} as never);
    expect(ok).toMatchObject({ found: true, danglingLinks: ["ghost"] });
    const miss = await tools.readMemory!.execute!({ slug: "nope" }, {} as never);
    expect(miss).toMatchObject({ found: false });
  });

  it("updateMemory / deleteMemory operate by slug; unknown slug self-correct result", async () => {
    const db = freshDb();
    createMemory(db, { slug: "m", title: "t", description: "d", body: "b", sourceBookId: null });
    const tools = createMemoryTools({ db, bookId: null });
    const upd = await tools.updateMemory!.execute!({ slug: "m", title: "t2" }, {} as never);
    expect(upd).toMatchObject({ updated: true });
    const del = await tools.deleteMemory!.execute!({ slug: "m" }, {} as never);
    expect(del).toMatchObject({ deleted: true });
    const miss = await tools.deleteMemory!.execute!({ slug: "m" }, {} as never);
    expect(miss).toMatchObject({ deleted: false });
  });

  it("updateSoul patches name/persona and invalidates snapshots", async () => {
    const db = freshDb();
    const tools = createMemoryTools({ db, bookId: null });
    const out = await tools.updateSoul!.execute!({ name: "Mia" }, {} as never);
    expect(out).toMatchObject({ updated: true });
    expect(getPreference(db, "soul")?.name).toBe("Mia");
    expect(getPreference(db, "soul")?.persona).toBe(
      (await import("@shared/preferences")).DEFAULT_SOUL.persona,
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/memory-tools.test.ts`
Expected: FAIL

- [ ] **Step 3: 实现 memory-tools**

`src/main/ai/memory-tools.ts`（错误转工具结果而非抛出——模型自纠路径，spec §7；slug 形状用 `memorySlug` 复用单源）：

```typescript
// src/main/ai/memory-tools.ts —— Lia 的记忆/SOUL 写工具（spec 2026-06-10 §4）。
// 失败一律转结构化工具结果（模型自纠），不抛 IPC 错误；软失败留 log.warn。
import { tool } from "ai";
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

export function createMemoryTools(deps: MemoryToolsDeps) {
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
          danglingLinks: m.danglingLinks, // [[slug]] not yet written — worth creating later
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
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/ai/memory-tools.test.ts`
Expected: PASS

- [ ] **Step 5: 注册进 streamText**

`src/main/ai/stream-assistant.ts`（工具构造处，约 line 57-58）：

```typescript
const tools = {
  ...createReadingTools({ db, bookId, loadBytes, imageToolResults }),
  ...createMemoryTools({ db, bookId }),
};
```

（import `createMemoryTools`；`bookId` 此处恒为 string，符合 `string | null` 入参。）

- [ ] **Step 6: 全量验证 + Commit**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

```bash
git add src/main/ai/memory-tools.ts src/main/ai/memory-tools.test.ts src/main/ai/stream-assistant.ts
git commit -m "feat(memory): memory + soul tools registered into chat agent loop"
```

---

### Task 6: resolveChatModel（preferences 取模型，暂与 assistants 并存）

**Files:**

- Modify: `src/main/ai/assistant-model.ts`（新增 `resolveChatModel`；`resolveAssistantModel` 留待 Task 8 删除）
- Modify: `src/main/ai/send-deps.ts:28`（切换到 `resolveChatModel`）
- Test: `src/main/ai/assistant-model.test.ts`（若无则新建；先查 `ls src/main/ai/*.test.ts` 避免重名）

- [ ] **Step 1: 写失败测试**

```typescript
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { setPreference } from "@main/preferences/repository";
import { providers } from "@main/db/schema";
import { resolveChatModel } from "@main/ai/assistant-model";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

describe("resolveChatModel", () => {
  it("returns structured error when chatModel preference missing", () => {
    const db = freshDb();
    const r = resolveChatModel(db);
    expect(r.ok).toBe(false);
  });

  it("resolves model from chatModel preference", () => {
    const db = freshDb();
    const p = db
      .insert(providers)
      .values({ type: "anthropic", apiKey: "k", models: ["claude-x"] })
      .returning()
      .get();
    setPreference(db, "chatModel", { providerId: p.id, model: "claude-x" });
    const r = resolveChatModel(db);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.modelId).toBe("claude-x");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/assistant-model.test.ts`
Expected: FAIL（resolveChatModel 不存在）

- [ ] **Step 3: 实现 resolveChatModel**

`src/main/ai/assistant-model.ts` 追加（形态完全镜像 `resolveSummaryModel`，仅 preference key 与 i18n 文案不同）：

```typescript
/**
 * 把「聊天模型」偏好解析为可调用模型（spec 2026-06-10 §2.3：接替 assistants 表配置）。
 * 未配置 / provider 已删 / 无密钥一律结构化错误——显式报错，不静默回退。
 */
export function resolveChatModel(db: DB): ResolvedModel {
  const pref = getPreference(db, "chatModel");
  if (!pref) {
    return { ok: false, reason: t("errors.chatModelNotConfigured", "未配置对话模型") };
  }
  const provider = loadProvider(db, pref.providerId);
  if (!provider) {
    return {
      ok: false,
      reason: t("errors.configuredProviderNotFound", "未找到所配置的$t(terms.provider)"),
    };
  }
  if (!provider.apiKey) {
    return {
      ok: false,
      reason: t("errors.configuredProviderNoApiKey", "$t(terms.provider)未设置密钥"),
    };
  }
  try {
    const model = resolveLanguageModel({
      type: provider.type,
      baseUrl: provider.baseUrl,
      apiKey: provider.apiKey,
      model: pref.model,
    });
    return { ok: true, model, modelId: pref.model, providerType: provider.type };
  } catch (err) {
    return {
      ok: false,
      reason: err instanceof Error ? err.message : t("errors.failedToBuildModel", "构建模型失败"),
    };
  }
}
```

`src/main/ai/send-deps.ts:28` 改为：

```typescript
const resolveModel = () => resolveChatModel(db);
```

（import 同步更新；`resolveAssistantModel` 的 import 若仅此处使用则一并移除。）

- [ ] **Step 4: 跑测试 + i18n 抽取**

Run: `pnpm test && pnpm i18n:extract && pnpm typecheck`
Expected: PASS；`errors.chatModelNotConfigured` 进入 locales（en 用 "Chat model not configured"，对照 `errors.summaryModelNotConfigured` 的既有文案风格修各语言文件）。

- [ ] **Step 5: Commit**

```bash
git add src/main/ai/assistant-model.ts src/main/ai/assistant-model.test.ts src/main/ai/send-deps.ts src/shared/i18n
git commit -m "feat(memory): resolve chat model from preferences instead of assistants table"
```

---

### Task 7: send.ts 五层 system prompt 接线

**Files:**

- Create: `src/main/ai/base-prompt.ts`（①层内置模板）
- Modify: `src/main/ai/send.ts`（runSend 79-98 / runResend 171-194 两处同改）
- Test: `src/main/ai/base-prompt.test.ts`

- [ ] **Step 1: 实现 base-prompt（含 buildSystemPrompt 组装 helper）**

`src/main/ai/base-prompt.ts`：

```typescript
// src/main/ai/base-prompt.ts —— system prompt ①层内置模板 + 五层组装（spec 2026-06-10 §3）。
// 模板代码内维护（随版本进化）；吸收原 DEFAULT_SYSTEM_PROMPT 行为要点 + 记忆指引。
import type { DB } from "@main/db/client";
import { getAgentContext } from "@main/ai/agent-context";
import { getPreference } from "@main/preferences/repository";

export const BASE_SYSTEM_PROMPT = `You are a reading companion embedded in an e-book reader. The user is reading a book and may select text to ask about it. Ground your answers in the provided selection, surrounding paragraphs, and chapter summary. When you need more of the original text, use the available reading tools. Answer concisely, and always respond in the language the user is using.

## Memory guidance

You may have a persistent global memory about the reader, shared across all books and conversations. When a "Memory index" section is present below, every entry is listed as "[slug] title — description"; use readMemory to fetch full bodies when relevant.
- Save a memory (saveMemory) when the reader expresses a lasting preference, a personal viewpoint, a concept they keep returning to, a framework they use to understand things, or a correction to your behavior.
- Do NOT save book content itself (summaries cover that) or one-off transactional questions. The conversation summary is this session's working memory; only durable cross-session facts belong in saveMemory.
- The index is always visible: merge related entries with updateMemory instead of piling near-duplicates; use deleteMemory when asked to forget or when an entry is obsolete.
- In memory bodies, link related memories with [[slug]]. A [[slug]] that does not exist yet is fine — it marks something worth writing later.
- Write memory content in the reader's language; slugs are always English kebab-case.`;

/** 五层组装的 ①+②+③+④（⑤动态层 PDF note / priorSummary 由调用方拼接）。②③④走会话快照。 */
export function buildSystemPrompt(db: DB, conversationId: string): string {
  const agentContext = getAgentContext(db, conversationId);
  const memoryEnabled = getPreference(db, "memoryEnabled") ?? true;
  // memoryEnabled=off 时记忆指引整段无意义但无害；为保模板静态（快照只覆盖②③④），不动态裁剪①层。
  void memoryEnabled;
  return agentContext.length > 0 ? `${BASE_SYSTEM_PROMPT}\n\n${agentContext}` : BASE_SYSTEM_PROMPT;
}
```

- [ ] **Step 2: 写测试**

`src/main/ai/base-prompt.test.ts`：

```typescript
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { createMemory } from "@main/memory/repository";
import { invalidateAllAgentContexts } from "@main/ai/agent-context";
import { BASE_SYSTEM_PROMPT, buildSystemPrompt } from "@main/ai/base-prompt";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

beforeEach(() => invalidateAllAgentContexts());

describe("buildSystemPrompt", () => {
  it("starts with base template and appends agent context", () => {
    const db = freshDb();
    createMemory(db, { slug: "m", title: "T", description: "D", body: "b", sourceBookId: null });
    const text = buildSystemPrompt(db, "conv-1");
    expect(text.startsWith(BASE_SYSTEM_PROMPT)).toBe(true);
    expect(text).toContain("[m] T — D");
  });

  it("is verbatim-stable across turns of the same conversation", () => {
    const db = freshDb();
    const a = buildSystemPrompt(db, "conv-1");
    createMemory(db, { slug: "m2", title: "T", description: "D", body: "b", sourceBookId: null });
    expect(buildSystemPrompt(db, "conv-1")).toBe(a);
  });
});
```

Run: `pnpm test src/main/ai/base-prompt.test.ts`
Expected: PASS

- [ ] **Step 3: 改 runSend 与 runResend**

`src/main/ai/send.ts` 两处（line 79-92 与 171-183）同构替换——删除 `getDefaultAssistant` 取值，改为：

```typescript
// 5. 组装 prompt：①内置模板+②instructions+③SOUL+④记忆索引（会话快照冻结）+⑤PDF 注记
const book = getBook(db, input.bookId); // runResend 处为 convo.bookId
const imageToolResults = supportsImageToolResults(resolved.providerType);
let systemPromptText = buildSystemPrompt(db, conversationId); // runResend 处为 input.conversationId
if (book?.format === "pdf") {
  const note = pdfSystemNote({
    pageCount: book.pageCount,
    hasTextLayer: Boolean(book.hasTextLayer),
    imageMode: imageToolResults,
  });
  systemPromptText = `${systemPromptText}\n\n${note}`;
}
```

同时删除 `send.ts` 头部 `import { getDefaultAssistant } from "@main/providers/assistant";`，新增 `import { buildSystemPrompt } from "@main/ai/base-prompt";`。

- [ ] **Step 4: 全量验证 + Commit**

Run: `pnpm test && pnpm typecheck`
Expected: PASS（send 相关既有测试若断言旧 systemPrompt 形态需同步更新断言）

```bash
git add src/main/ai/base-prompt.ts src/main/ai/base-prompt.test.ts src/main/ai/send.ts
git commit -m "feat(memory): five-layer system prompt with frozen agent context in send pipeline"
```

---

### Task 8: 原子删除 assistants（schema + 迁移数据搬运 + 全部代码引用）

**Files:**

- Modify: `src/main/db/schema.ts`（删 `assistants` 表、`conversations.assistantId` 列）
- Generate+Edit: 新迁移目录（生成后**手工在文件头插入数据搬运 SQL**——项目「勿手编迁移」规则的有意例外：drizzle 不生成数据迁移，搬运必须在 DROP 之前执行）
- Delete: `src/main/providers/assistant.ts`、`src/shared/assistant.ts`
- Modify: `src/shared/ipc.ts:211-212`（删 `assistantGetDefault`/`assistantUpdate`）
- Modify: `src/main/ipc/settings-handlers.ts:51-53`（删两条 bind）
- Modify: `src/preload-api.ts:95-98`（删 `settings.assistant` 段）
- Modify: `src/main/chat/conversations.ts`（删 `getDefaultAssistant` 引用与 `assistantId` 写入/DTO 字段）
- Modify: `src/shared/chat.ts:65-69`（ConversationDto 删 `assistantId`）
- Modify: `src/main/ai/assistant-model.ts`（删 `resolveAssistantModel` 及其 import）
- Modify: `src/renderer/settings/AssistantModelPicker.tsx`（改读写 `chatModel` preference，模式照抄 `SummaryModelPicker.tsx`）
- Modify: `src/renderer/store/prefs-store.ts`（加 `chatModel` 字段 + setter，镜像 `summaryModel`）
- Test: 更新 `src/main/chat/conversations.test.ts` 中 assistantId 断言

- [ ] **Step 1: schema 删除**

`src/main/db/schema.ts`：整段删除 `export const assistants = sqliteTable(...)`（line 52-59）；`conversations` 表删除 `assistantId` 列定义（line 166-168）。

- [ ] **Step 2: 生成迁移并手工前插数据搬运 SQL**

Run: `pnpm db:generate`

生成的 `migration.sql` 会含 conversations 表重建与 `DROP TABLE assistants`。在该文件**最前面**插入（`--> statement-breakpoint` 分隔；必须先搬运后 DROP）：

```sql
INSERT INTO `preferences`(`key`, `value`, `updated_at`)
SELECT 'chatModel', json_object('providerId', `provider_id`, 'model', `model`), CAST(strftime('%s','now') AS INTEGER) * 1000
FROM `assistants`
WHERE `provider_id` IS NOT NULL AND `model` IS NOT NULL
ORDER BY `created_at` ASC LIMIT 1
ON CONFLICT(`key`) DO NOTHING;
--> statement-breakpoint
INSERT INTO `preferences`(`key`, `value`, `updated_at`)
SELECT 'instructions', json_quote(`system_prompt`), CAST(strftime('%s','now') AS INTEGER) * 1000
FROM `assistants`
WHERE `system_prompt` IS NOT NULL
  AND `system_prompt` != 'You are a reading assistant embedded in an e-book reader. The user is reading a book and may select text to ask about it. Ground your answers in the provided selection, surrounding paragraphs, and chapter summary. When you need more of the original text, use the available reading tools. Answer concisely.'
ORDER BY `created_at` ASC LIMIT 1
ON CONFLICT(`key`) DO NOTHING;
--> statement-breakpoint
```

（第二条的字面量必须与原 `DEFAULT_SYSTEM_PROMPT` 逐字一致——未自定义则不搬，spec §2.3。`json_quote` 产出 JSON 字符串值，与 `mode:"json"` 列读取兼容。）

- [ ] **Step 3: 删代码引用（按上方 Files 清单逐个）**

要点：

- `src/main/chat/conversations.ts`：`toDto` 删 `assistantId` 行；`createConversation` 删 `getDefaultAssistant` 调用，insert 改 `.values({ bookId: input.bookId })`；删 import。
- `src/shared/chat.ts`：`ConversationDto` 删 `assistantId: string;` 与注释中 assistantId 字样。
- `src/shared/ipc.ts`：删两条通道 def 与 `AssistantDto`/`updateAssistantInput` import。
- `src/preload-api.ts`：删 `assistant: {...}` 段。
- `src/main/ipc/settings-handlers.ts`：删两条 bind 与 import。
- `src/main/ai/assistant-model.ts`：删 `resolveAssistantModel` 函数与 `getDefaultAssistant` import。
- 删除文件：`git rm src/main/providers/assistant.ts src/shared/assistant.ts`。
- `AssistantModelPicker.tsx`：删除 `qk.assistantDefault` 查询与 `window.api.settings.assistant.*` 调用，改为镜像 `SummaryModelPicker.tsx` 的 `usePrefsStore` 读写（字段 `chatModel`/`setChatModel`）；`prefs-store.ts` 加：

```typescript
  chatModel: ChatModel | null;
  // ...
  setChatModel: (chatModel) => {
    persistPreference({ key: "chatModel", value: chatModel });
    set({ chatModel });
  },
```

（hydrate 初值来自 preferences snapshot，镜像 summaryModel 的既有写法；`qk.assistantDefault` 查询键定义一并删除。）

- [ ] **Step 4: 修测试**

`src/main/chat/conversations.test.ts`：删除 `expect(convo.assistantId).not.toBeNull()` 类断言。grep 验证无残留：

Run: `grep -rin "assistant" src/ --include="*.ts" --include="*.tsx" | grep -v "stream-assistant\|assistant-model\|message\|Assistant 消息"`
Expected: 仅剩 `assistant-model.ts` 文件名（含 resolveChatModel/resolveSummaryModel，文件名沿用不强改）、`role: "assistant"`（消息角色，非 assistants 表概念）等无关命中。

- [ ] **Step 5: 全量验证**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: PASS

- [ ] **Step 6: 旧库迁移冒烟（数据搬运验证）**

```bash
cp "$HOME/Library/Application Support/marginalia-dev/marginalia.db" /tmp/mig-smoke.db 2>/dev/null || echo "no dev db; skip"
# 有 dev 库时：启动 app 跑迁移后检查
sqlite3 "$HOME/Library/Application Support/marginalia-dev/marginalia.db" \
  "SELECT key, value FROM preferences WHERE key IN ('chatModel','instructions');"
```

Expected: 原默认助手配过 provider/model 则 `chatModel` 行存在且 JSON 正确；`systemPrompt` 未自定义则无 `instructions` 行。

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat(memory)!: drop assistants table in favor of chatModel preference + built-in prompt

Data migration carries provider/model into preferences.chatModel and a
customized systemPrompt into preferences.instructions before DROP."
```

---

### Task 9: memories IPC（list / update / delete）+ preload

**Files:**

- Modify: `src/shared/ipc.ts`（三条通道）
- Create: `src/main/ipc/memory-handlers.ts`
- Modify: 主进程 handler 注册点（grep `registerSettingsHandlers()` 的调用处，通常 `src/main/main.ts`，旁边加 `registerMemoryHandlers()`）
- Modify: `src/preload-api.ts`（暴露 `memories` 命名空间）

- [ ] **Step 1: 通道定义**

`src/shared/ipc.ts`（import `MemoryDto`、`updateMemoryInput`、`deleteMemoryInput` from `@shared/memory`）：

```typescript
  memoriesList: def("memories:list", "invoke", z.void(), out<MemoryDto[]>()),
  memoriesUpdate: def("memories:update", "invoke", updateMemoryInput, out<MemoryDto | null>()),
  memoriesDelete: def("memories:delete", "invoke", deleteMemoryInput, out<void>()),
```

- [ ] **Step 2: handler**

`src/main/ipc/memory-handlers.ts`：

```typescript
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
```

- [ ] **Step 3: preload 暴露**

`src/preload-api.ts`（与 `settings`/`preferences` 平级）：

```typescript
  memories: {
    list: inv(C.memoriesList),
    update: inv(C.memoriesUpdate),
    delete: inv(C.memoriesDelete),
  },
```

并在主进程注册点（`registerSettingsHandlers()` 旁）调用 `registerMemoryHandlers()`。

- [ ] **Step 4: 验证 + Commit**

Run: `pnpm test && pnpm typecheck`
Expected: PASS

```bash
git add src/shared/ipc.ts src/main/ipc/memory-handlers.ts src/preload-api.ts src/main/main.ts
git commit -m "feat(memory): memories list/update/delete IPC channels"
```

---

### Task 10: 设置页——记忆版块 + 助手版块

**Files:**

- Create: `src/renderer/settings/MemorySettings.tsx`
- Create: `src/renderer/settings/AgentSettings.tsx`
- Modify: `src/renderer/settings/SettingsShell.tsx`（两个新 tab）
- Modify: `src/renderer/store/prefs-store.ts`（`memoryEnabled`/`soul`/`instructions` 字段 + setter，镜像既有模式）

UI 风格对齐既有 settings 组件（shadcn/Base UI、Tailwind 类、`@renderer/logger`、i18n `t()`——所有文案过 i18n，勿硬编码）。

- [ ] **Step 1: prefs-store 加三个 key**

镜像 `summaryModel` 模式（state 字段 + hydrate 初值 + setter 调 `persistPreference`）：`memoryEnabled`（默认 `true`）、`soul`（默认 `DEFAULT_SOUL`）、`instructions`（默认 `""`）。

- [ ] **Step 2: MemorySettings 组件**

结构（react-query 读 `window.api.memories.list`；staleTime 默认即可——设置页打开时 refetch）：

```tsx
// 要素：
// 1. 总开关 Switch —— usePrefsStore(s => s.memoryEnabled) / setMemoryEnabled
// 2. 记忆列表：title + description + sourceBookTitle + 日期；点击展开 body（[[slug]] 纯文本展示）
// 3. 行内编辑（title/description/body 文本域 + 保存调 window.api.memories.update 后 invalidate 查询）
// 4. 删除按钮 → AlertDialog 确认（项目规约：禁 OS 弹窗）→ window.api.memories.delete
// 5. 空态文案：「Lia 还没有记忆——在对话中自然积累」（i18n key）
```

- [ ] **Step 3: AgentSettings 组件**

```tsx
// 要素：
// 1. name 输入框 + persona 文本域 —— usePrefsStore soul / setSoul（onBlur 提交，匹配既有设置组件交互）
// 2. instructions 文本域 —— usePrefsStore instructions / setInstructions
// 3. chatModel 选择器 —— 复用 Task 8 改造后的 AssistantModelPicker（更名 ChatModelPicker 并移入本版块；
//    若 ModelsSettings 已含它则保持原位、本版块只放 SOUL + instructions，落点按现有 IA 取舍）
```

- [ ] **Step 4: SettingsShell 注册 tab + i18n**

新 tab：`memory`（记忆）与 `agent`（助手）。跑 `pnpm i18n:extract` 后为新增 key 补 zh/其他 locale 文案。

- [ ] **Step 5: 验证 + Commit**

Run: `pnpm typecheck && pnpm lint && pnpm i18n:lint && pnpm test`
Expected: PASS

```bash
git add src/renderer src/shared/i18n
git commit -m "feat(memory): settings panels for memory management and agent persona"
```

---

### Task 11: 聊天 UI 显示 soul.name

**Files:**

- Modify: 聊天面板标题/助手署名处（定位：`grep -rn "aiPanel\|assistantName\|panelTitle" src/renderer --include="*.tsx" -i` + 看 AI 面板组件的标题 i18n key）

- [ ] **Step 1: 定位 AI 面板标题/署名渲染点**，将静态文案替换为 `usePrefsStore((s) => s.soul.name)`（fallback `DEFAULT_SOUL.name`）。涉及 i18n 插值的（如「与 AI 对话」）改为带 `{{name}}` 插值的 key。

- [ ] **Step 2: 验证 + Commit**

Run: `pnpm typecheck && pnpm i18n:extract && pnpm i18n:lint`
Expected: PASS

```bash
git add src/renderer src/shared/i18n
git commit -m "feat(memory): show agent name (soul.name) in chat UI"
```

---

### Task 12: 收尾——changeset + 全量验证 + 真启动冒烟

- [ ] **Step 1: changeset**

Run: `pnpm changeset`（minor）；用户向英文条目，例如：

> Your reading companion now has a name (Lia by default), an editable persona, and a global long-term memory: it remembers your preferences, viewpoints, and recurring concepts across books and conversations, with full review/edit/delete control in Settings → Memory. Custom instructions replace the old assistant system prompt.

- [ ] **Step 2: 全量验证**

Run: `pnpm test:all && pnpm typecheck && pnpm lint && pnpm format:check && pnpm i18n:lint`
Expected: 全 PASS

- [ ] **Step 3: 真启动冒烟（Playwright CDP，参考既有冒烟脚本模式）**

```bash
pnpm start -- --remote-debugging-port=9222 --user-data-dir=/tmp/memory-smoke
```

冒烟清单：

1. 设置 → 助手：改 name 为「小墨」→ 聊天面板标题随之变化。
2. 设置里配置 chatModel（真 provider）→ 打开书 → 对话「请记住：我喜欢用经济学框架理解问题」→ 观察 inline tool steps 出现 `saveMemory` 调用 → 设置 → 记忆面板出现该条目。
3. 新建会话 → 问「我喜欢用什么框架思考？」→ 回答应引用记忆（索引注入生效）。
4. 设置 → 记忆：编辑/删除条目、关总开关后对话不再出现记忆工具调用。
5. `sqlite3 /tmp/memory-smoke/marginalia.db "SELECT slug FROM memories; SELECT key FROM preferences;"` 验证落盘。

- [ ] **Step 4: Commit + 收尾流程**

```bash
git add .changeset
git commit -m "chore(memory): add changeset for global memory + soul"
```

然后走 superpowers:finishing-a-development-branch（合并 rebase 线性、kanban 挪卡、commit message 带 `closes #77`）。

---

## Self-Review 记录

- **Spec 覆盖**：§2.1/2.1.1（Task 1,3）、§2.2（Task 2）、§2.3（Task 6,8）、§3（Task 4,7）、§4（Task 5）、§5（Task 4）、§6（Task 9,10）、§7（Task 3,5 错误形态）、§8（各 task 测试）、§9 本期范围全覆盖。
- **类型一致性**：`MemoryDto`/`MemoryDetail`/`CreateMemoryInput` 定义于 Task 3，Task 5/9/10 引用同名；`ChatModel`/`Soul`/`DEFAULT_SOUL` 定义于 Task 2，Task 4/5/6/8/10/11 引用同名；快照 API 四函数名在 Task 4 定义、Task 5/7 引用一致。
- **顺序约束**：Task 1–7 全程 typecheck 绿（assistants 仍在）；Task 8 原子删除；迁移搬运 SQL 在 DROP 前。
