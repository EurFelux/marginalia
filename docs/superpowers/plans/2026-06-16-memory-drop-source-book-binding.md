# 记忆去除来源书绑定 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 删除 `memories.sourceBookId` 列（连同 FK 与索引）及其全部消费点，让记忆与 `books` 表彻底解耦；「来自哪本书」改由记忆自身文本承载，DB 不做结构约束。

**Architecture:** 这是一次**类型耦合的删除重构**——`sourceBookId` 在 schema → drizzle 推导类型 → `CreateMemoryInput`/`MemoryDto` → 工具/整理/UI 各层贯穿。删除必须一次性贯通，无干净的中间「绿」态，故全部改动落在**单个原子提交**里，以 `pnpm typecheck` + `pnpm test`（全量，覆盖迁移路径）+ `pnpm lint` 三闸验证。TDD 在删除重构里退化为「类型系统即测试」：typecheck 绿 = 字段已从所有类型移除；同时删掉那条已失语义的 SET NULL 测试。

**Tech Stack:** Drizzle ORM 1.0-rc + better-sqlite3、Zod 4、TypeScript 6、vitest 4（跑在 Electron 运行时）、React 19、oxlint/oxfmt。

参考 spec：`docs/superpowers/specs/2026-06-16-memory-drop-source-book-binding-design.md`

---

### Task 1: 端到端删除 `sourceBookId`（单原子提交）

**Files:**

- Modify: `src/main/db/schema.ts`（`memories` 表）
- Create: `src/main/db/migrations/<timestamp>_<name>/`（`pnpm db:generate` 产出）
- Modify: `src/shared/memory.ts`（`MemoryDto`）
- Modify: `src/main/memory/repository.ts`（`CreateMemoryInput`、`listMemories`、import）
- Modify: `src/main/ai/memory-tools.ts`（`MemoryToolsDeps`、`saveMemory`）
- Modify: `src/main/ai/memory-consolidation.ts`（`applyMemoryOps`、`maybeConsolidateMemory`）
- Modify: `src/main/ai/stream-assistant.ts`（两处调用）
- Modify: `src/renderer/settings/MemorySettings.tsx`（来源书名展示块）
- Modify: `src/main/memory/repository.test.ts`
- Modify: `src/main/ai/memory-tools.test.ts`
- Modify: `src/main/ai/memory-consolidation.test.ts`
- Modify: `src/main/ai/agent-context.test.ts`
- Modify: `src/main/ai/base-prompt.test.ts`

> 实现期间 typecheck 会一路飘红，直到全部步骤改完——这是删除重构的预期，**仅在最后统一验证**，勿中途纠结单步红。

- [ ] **Step 1: 改 schema——删列 + 删索引**

`src/main/db/schema.ts`，把 `memories` 表（当前带第三参 `(t) => [index(...)]`）整体替换为（去掉 `sourceBookId` 列、去掉溯源注释、去掉唯一的索引故连第三参一并删除）：

```ts
// AI 全局记忆（spec 2026-06-10-ai-global-memory-soul-design §2.1；2026-06-16 去除来源书绑定）。
// slug 是 AI 侧统一标识符（工具入参 / [[互链]] / 索引展示），创建后不可改；uuid 主键仅内部用。
export const memories = sqliteTable("memories", {
  id: pkUuid(),
  slug: text("slug").notNull().unique(),
  title: text("title").notNull(),
  description: text("description").notNull(), // 一行摘要：常驻注入 system prompt 的就是它
  body: text("body").notNull(), // 详细正文：readMemory 按需取；可含 [[slug]] 互链
  createdAt: nowMs(),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});
```

`books`/`index`/`primaryKey` 等 import 仍被其它表使用，**勿删**。

- [ ] **Step 2: 生成迁移**

Run: `pnpm db:generate`
Expected: 新增目录 `src/main/db/migrations/<timestamp>_<name>/`，含 `migration.sql` + `snapshot.json`。`migration.sql` 应是表重建（建无 `source_book_id` 列的新表 → 拷数据 → 丢旧表 → 改名）并 `DROP INDEX memories_source_book_id_idx`。**不要手工编辑**生成的迁移文件。

- [ ] **Step 3: 改 `MemoryDto`**

`src/shared/memory.ts`，把 `MemoryDto` 接口（含注释）替换为：

```ts
/** 管理面板用的记忆视图。 */
export interface MemoryDto {
  id: string;
  slug: string;
  title: string;
  description: string;
  body: string;
  createdAt: number;
  updatedAt: number;
}
```

- [ ] **Step 4: 改 repository——入参类型 + 查询 + import**

`src/main/memory/repository.ts`：

① import（第 5 行）去掉 `books`：

```ts
import { memories, memoryLinks } from "@main/db/schema";
```

② `CreateMemoryInput` 去 `sourceBookId`：

```ts
export interface CreateMemoryInput {
  slug: string;
  title: string;
  description: string;
  body: string;
}
```

③ `listMemories` 去掉 join 与两个来源字段：

```ts
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
```

`createMemory` 函数体无需改（`tx.insert(memories).values(input)` 随 `CreateMemoryInput` 收窄自动对齐）。

- [ ] **Step 5: 改 memory-tools——去 bookId 死参**

`src/main/ai/memory-tools.ts`：

① `MemoryToolsDeps`（去 `bookId` 字段及其注释）：

```ts
export interface MemoryToolsDeps {
  db: DB;
}
```

② 解构（第 27 行）：`const { db } = deps;`

③ `saveMemory` 的 `execute`（第 85 行）调用去 `sourceBookId`：

```ts
createMemory(db, { slug, title, description, body });
```

- [ ] **Step 6: 改 memory-consolidation——去 opts 与 bookId 死参**

`src/main/ai/memory-consolidation.ts`：

① `applyMemoryOps` 签名去掉第三参：

```ts
export function applyMemoryOps(db: DB, ops: MemoryOp[]): ApplyResult {
```

② `save` 分支的 `createMemory` 调用去 `sourceBookId`：

```ts
createMemory(db, {
  slug: op.slug,
  title: op.title,
  description: op.description,
  body: op.body,
});
```

③ `maybeConsolidateMemory` 签名去掉 `bookId` 形参（其唯一用途即喂 sourceBookId）：

```ts
export async function maybeConsolidateMemory(
  deps: ConsolidationDeps,
  conversationId: string,
  everyN = MEMORY_PASS_EVERY_N_TURNS,
): Promise<void> {
```

④ 函数体内调用 `applyMemoryOps`（原第 302 行）去掉 opts 实参：

```ts
const applied = applyMemoryOps(db, parsed.ops);
```

- [ ] **Step 7: 改 stream-assistant——两处调用收口**

`src/main/ai/stream-assistant.ts`：

① 第 61 行：

```ts
const memoryTools = createMemoryTools({ db });
```

② `maybeConsolidateMemory` 调用（原第 173–177 行）去掉 `bookId` 实参：

```ts
void maybeConsolidateMemory(
  { db, resolveModel: resolveSummaryModel, runBackground, notify },
  conversationId,
);
```

`bookId` 变量本身保留（第 74 行 `createContextTools` 等仍用）。

- [ ] **Step 8: 改 MemorySettings——删来源书名展示**

`src/renderer/settings/MemorySettings.tsx`，删除展示态标题旁的来源块（原 211–215 行）：

```tsx
{
  mem.sourceBookTitle && (
    <span className="shrink-0 text-[11px] text-muted-foreground">· {mem.sourceBookTitle}</span>
  );
}
```

删除后该 `<button>` 内仅余 chevron 图标 + `<span className="truncate text-sm font-medium">{mem.title}</span>`。

- [ ] **Step 9: 改 repository.test.ts**

`src/main/memory/repository.test.ts`：

① 删除 import 中已变死的 `eq` 与 `books`：把第 2 行 `import { eq } from "drizzle-orm";` 整行删除；第 5 行 `import { books } from "@main/db/schema";` 整行删除。

② 所有 `createMemory(db, { ... })` 调用去掉 `sourceBookId: null,` 这一项（共 8 处：第 25–31、38、40–46、52–58、59–65、76–82、83–89、114、115、116–122、128、129 块内的该字段）。

③ **删除整个** "keeps memory on book deletion (sourceBookId SET NULL)" 用例（原第 98–110 行）——FK 与 SET NULL 行为已不存在。

示例（首个用例改后形态）：

```ts
it("creates and reads a memory by slug", () => {
  const db = freshDb();
  const m = createMemory(db, {
    slug: "econ-framework",
    title: "经济学框架",
    description: "用经济学框架理解社会问题",
    body: "详细正文",
  });
  expect(m.slug).toBe("econ-framework");
  expect(getMemoryBySlug(db, "econ-framework")?.id).toBe(m.id);
});
```

- [ ] **Step 10: 改 memory-tools.test.ts**

`src/main/ai/memory-tools.test.ts`：

① 所有 `createMemoryTools({ db, bookId: ... })` 改为 `createMemoryTools({ db })`（第 21、27、40、58、69、81 行）。

② 第 39、51–57、68 行的 `createMemory(...)` 去掉 `sourceBookId: null`。

③ 把 "saveMemory fills sourceBookId from deps and returns the slug" 用例（第 25–35 行）改写为只断言保存成功并回 slug：

```ts
it("saveMemory saves a new memory and returns the slug", async () => {
  const db = freshDb();
  const tools = createMemoryTools({ db });
  if (!tools.saveMemory) throw new Error("expected full toolset");
  const out = await tools.saveMemory.execute!(
    { slug: "econ", title: "T", description: "D", body: "B" },
    {} as never,
  );
  expect(out).toMatchObject({ saved: true, slug: "econ" });
  expect(getMemoryBySlug(db, "econ")).not.toBeNull();
});
```

- [ ] **Step 11: 改 memory-consolidation.test.ts**

`src/main/ai/memory-consolidation.test.ts`：

① import（第 13 行）去掉已变死的 `books`：

```ts
import { memoryLinks, conversations } from "@main/db/schema";
```

② 把首个用例 "saves a new memory and fills sourceBookId"（第 74–95 行）改写为不 seed book、不带 opts、不断言 sourceBookId：

```ts
it("saves a new memory", () => {
  const db = freshDb();
  const r = applyMemoryOps(db, [
    {
      op: "save",
      slug: "likes-stoicism",
      title: "T",
      description: "D",
      body: "B",
      reason: "x",
    },
  ]);
  expect(r).toEqual({ saved: 1, updated: 0, deleted: 0 });
  expect(getMemoryBySlug(db, "likes-stoicism")).not.toBeNull();
});
```

③ 其余 `applyMemoryOps(...)` 调用去掉末尾 `{ sourceBookId: ... }` 实参（第 97–113、115–123、125–133、135–147、149–174 块内，共 5 处）。例：

```ts
const r = applyMemoryOps(db, [
  { op: "save", slug: "dup", title: "new", description: "d2", body: "b2", reason: "x" },
]);
```

```ts
const r = applyMemoryOps(db, [{ op: "update", slug: "m", title: "fresh", reason: "x" }]);
```

```ts
const r = applyMemoryOps(db, [{ op: "delete", slug: "gone", reason: "merged" }]);
```

④ 第 99–105、117、151–157 行的 `createMemory(...)` 去掉 `sourceBookId: null`。

⑤ `mem()` 夹具（第 190–201 行）去掉两个来源字段：

```ts
function mem(slug: string, body: string): MemoryDto {
  return {
    id: slug,
    slug,
    title: `T-${slug}`,
    description: `D-${slug}`,
    body,
    createdAt: 0,
    updatedAt: 0,
  };
}
```

⑥ 所有 `maybeConsolidateMemory` 调用去掉 `bookId` 实参，并把 `const { db, conversationId, bookId } = await seedConvo(...)` 改为 `const { db, conversationId } = await seedConvo(...)`（第 285–296、298–309、311–337、339–351、353–370、372–393、395–427 共 7 个用例）。例（去 bookId 实参后）：

```ts
await maybeConsolidateMemory(
  { db, resolveModel: () => opsModel([]), runBackground: passThrough, notify },
  conversationId,
  2,
);
```

⑦ "applies ops, advances the watermark, and notifies on change" 用例里把 sourceBookId 断言（第 329 行 `expect(getBySlug(db, "new-fact")?.sourceBookId).toBe(bookId);`）改为：

```ts
expect(getBySlug(db, "new-fact")).not.toBeNull();
```

> `seedConvo` 的返回保留 `bookId` 字段无妨（调用方不再解构即可）。

- [ ] **Step 12: 改 agent-context.test.ts / base-prompt.test.ts**

各 `createMemory(...)` 去掉 `sourceBookId: null`：

- `src/main/ai/agent-context.test.ts` 第 35、36、46、57、76、82 行
- `src/main/ai/base-prompt.test.ts` 第 27、36 行

- [ ] **Step 13: 全量验证三闸**

Run: `pnpm typecheck`
Expected: 无错误（`sourceBookId`/`sourceBookTitle` 已从所有类型消失，无残留引用）。

Run: `pnpm test`
Expected: 全绿。**必须全量跑**（覆盖迁移在既有数据上的重建路径），不可只跑单文件。

Run: `pnpm lint`
Expected: 无错误（确认 `eq`/`books`/`bookId` 等死 import / 死变量已清干净）。

若 typecheck 报 "Property 'sourceBookId' does not exist" 或 lint 报未用变量，按报错定位漏改处补齐，再重跑三闸。

- [ ] **Step 14: 提交**

```bash
git add -A
git commit -m "refactor(memory): drop sourceBookId binding to books"
```

> 预提交 prek 会跑 lint:fix + format，可能改动文件并以 "files were modified by this hook" 中止；遇到则 `git add -A` 后重跑同一 commit 命令（第二次通过）。

---

## Self-Review

**Spec coverage：**

- §2 Schema 改动（删列+删索引+迁移）→ Step 1、2 ✅
- §3 消费点表 6 文件 → Step 3（shared）、4（repository）、5（memory-tools）、6（consolidation）、7（stream-assistant）、8（MemorySettings）✅
- §4 测试改动 5 文件（含删 SET NULL 用例、改写两处 sourceBookId 用例）→ Step 9–12 ✅
- §6 风险（全量 test 验迁移、死参清理、i18n 无关）→ Step 13 三闸覆盖 ✅
- §5 范围之外（不引快照列、不动互链/SOUL）→ 计划无相关任务，符合 ✅

**Placeholder scan：** 无 TBD/TODO；每个改代码步骤均给出完整新代码或精确删除范围。迁移文件因 `db:generate` 动态产出，已说明预期形态并明确禁止手工编辑（非占位）。

**Type consistency：** `CreateMemoryInput`（Step 4）= `{ slug, title, description, body }`，与 `saveMemory`（Step 5）、`applyMemoryOps` save 分支（Step 6）的 `createMemory` 调用一致；`MemoryDto`（Step 3）去字段后，`listMemories`（Step 4）select 列、`mem()` 夹具（Step 11⑤）一致；`maybeConsolidateMemory(deps, conversationId, everyN)`（Step 6）与全部调用（Step 7、11⑥）一致。

## 收尾提示（执行完后）

- 合并前若 `main` 已新增其它迁移：本迁移可能需删掉重 `pnpm db:generate` 排到最后（避免按旧 snapshot 冲坏既有库），验证靠全量 `pnpm test`（见既有教训「rebase 后重生成 drizzle 迁移」）。
- 走 finishing 流程时按惯例补一条用户向英文 changeset（`pnpm changeset`），并用 `kanban` skill 检查有无可关联/关闭的 issue。
