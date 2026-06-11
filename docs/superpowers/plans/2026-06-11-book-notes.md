# 书籍级独立笔记（Book Notes）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为每本书提供独立于选区标注的多条 Markdown 笔记（CRUD），挂载在阅读器侧栏第 4 个 tab 与书库书卡右键 Dialog 两处。

**Architecture:** 新表 `book_notes` + 四条 `book-notes:*` IPC 通道，完全镜像 annotations 模块的「Zod 契约（shared）→ 纯函数（main）→ bind 胶水（ipc）→ preload → React Query」分层。渲染层一个共享 `BookNotesPanel`（只读 Markdown 卡片流）+ `BookNoteEditorDialog`（镜像 NoteModal 交互），两个挂载点渲染同一组件。

**Tech Stack:** Drizzle ORM + better-sqlite3、Zod 4、React 19（React Compiler，勿手写 useCallback/useMemo）、TanStack Query、streamdown（`LocalizedStreamdown`）、vitest（`:memory:` SQLite）。

**Spec:** `docs/superpowers/specs/2026-06-11-book-notes-design.md`（决策真相源；本计划是其逐字落地）

**约定提醒：**

- 每次 commit 可能被 prek hook（lint:fix + format）改文件而中止——重新 `git add` 后原样重跑一次即可。
- 渲染层禁裸 `console.*`、禁内联 style（静态值）、禁手写 useCallback/useMemo。
- 改/新增 `t()` 文案后必须先 `pnpm i18n:extract` 再 typecheck。

---

### Task 0: 建特性分支

**Files:** 无

- [ ] **Step 0.1: 从 main 建分支**

```bash
git checkout -b feat/book-notes
```

- [ ] **Step 0.2: 把 kanban #79 挪到 In progress**

```bash
ITEM_ID=$(gh project item-list 1 --owner EurFelux --format json \
  --jq '.items[] | select(.content.number == 79) | .id')
gh project item-edit --id "$ITEM_ID" --project-id PVT_kwHOA4Ur5c4BZ8B7 \
  --field-id PVTSSF_lAHOA4Ur5c4BZ8B7zhU3Kj4 --single-select-option-id 47fc9ee4
```

---

### Task 1: DB schema 与迁移

**Files:**

- Modify: `src/main/db/schema.ts`（在 `annotations` 表定义之后、`conversations` 之前插入）
- Create: `src/main/db/migrations/<timestamp>_*/`（由 drizzle-kit 生成，勿手写）

- [ ] **Step 1.1: 在 schema.ts 添加 bookNotes 表**

在 `annotations` 表定义（约 L149 的 `);` 之后）插入：

```ts
export const bookNotes = sqliteTable(
  "book_notes",
  {
    id: pkUuid(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    // Markdown 源码；trim 后非空由 Zod 入口校验（shared/book-notes.ts）
    content: text("content").notNull(),
    createdAt: nowMs(),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [index("book_notes_book_id_idx").on(t.bookId)],
);
```

- [ ] **Step 1.2: 生成迁移**

```bash
pnpm db:generate
```

Expected: `src/main/db/migrations/` 新增一个含 `migration.sql` + `snapshot.json` 的子目录，SQL 含 `CREATE TABLE book_notes` 与索引。

- [ ] **Step 1.3: 跑既有测试确认迁移不破坏现状**

```bash
pnpm test
```

Expected: 全部 PASS（既有测试用 `runMigrations` 走全量迁移目录）。

- [ ] **Step 1.4: Commit**

```bash
git add src/main/db/schema.ts src/main/db/migrations
git commit -m "feat(notes): add book_notes table and migration"
```

---

### Task 2: 共享契约（DTO + Zod + IPC 通道）

**Files:**

- Create: `src/shared/book-notes.ts`
- Create: `src/shared/book-notes.test.ts`
- Modify: `src/shared/ipc.ts`

- [ ] **Step 2.1: 写失败的 Zod 校验测试**

创建 `src/shared/book-notes.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { createBookNoteInput, updateBookNoteInput } from "@shared/book-notes";

describe("book note input schemas", () => {
  it("accepts valid create input and trims content", () => {
    const r = createBookNoteInput.parse({ bookId: "b1", content: "  hello **md**  " });
    expect(r.content).toBe("hello **md**");
  });

  it("rejects empty and whitespace-only content on create", () => {
    expect(createBookNoteInput.safeParse({ bookId: "b1", content: "" }).success).toBe(false);
    expect(createBookNoteInput.safeParse({ bookId: "b1", content: "   \n " }).success).toBe(false);
  });

  it("rejects whitespace-only content on update patch", () => {
    expect(updateBookNoteInput.safeParse({ id: "n1", patch: { content: " " } }).success).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2.2: 跑测试确认失败**

```bash
pnpm test src/shared/book-notes.test.ts
```

Expected: FAIL（模块 `@shared/book-notes` 不存在）。

- [ ] **Step 2.3: 实现 shared/book-notes.ts**

```ts
// src/shared/book-notes.ts
import { z } from "zod";

export interface BookNoteDto {
  id: string;
  bookId: string;
  content: string;
  createdAt: number;
  updatedAt: number;
}

// content：.trim() 是转换——校验且落库的都是 trim 后的 Markdown 源码
export const createBookNoteInput = z.object({
  bookId: z.string().min(1),
  content: z.string().trim().min(1),
});
export type CreateBookNoteInput = z.infer<typeof createBookNoteInput>;

export const updateBookNoteInput = z.object({
  id: z.string().min(1),
  patch: z.object({ content: z.string().trim().min(1) }),
});
export type UpdateBookNoteInput = z.infer<typeof updateBookNoteInput>;

export const bookNoteIdInput = z.object({ id: z.string().min(1) });
export type BookNoteIdInput = z.infer<typeof bookNoteIdInput>;
```

- [ ] **Step 2.4: 在 ipc.ts 注册四条通道**

`src/shared/ipc.ts` 顶部 import 区（`@shared/annotations` import 之后）加：

```ts
import type { BookNoteDto } from "@shared/book-notes";
import { bookNoteIdInput, createBookNoteInput, updateBookNoteInput } from "@shared/book-notes";
```

`C` 对象内、`// annotations` 段（`annotationsDelete` 行）之后加：

```ts
  // book notes（书籍级独立笔记，独立于选区标注）
  bookNotesListByBook: def("book-notes:list-by-book", "invoke", bookIdInput, out<BookNoteDto[]>()),
  bookNotesCreate: def("book-notes:create", "invoke", createBookNoteInput, out<BookNoteDto>()),
  bookNotesUpdate: def("book-notes:update", "invoke", updateBookNoteInput, out<BookNoteDto>()),
  bookNotesDelete: def("book-notes:delete", "invoke", bookNoteIdInput, out<void>()),
```

（`bookIdInput` 已从 `@shared/library` import，直接复用。）

- [ ] **Step 2.5: 跑测试与 typecheck 确认通过**

```bash
pnpm test src/shared/book-notes.test.ts && pnpm typecheck
```

Expected: 3 个测试 PASS；typecheck 无错误。

- [ ] **Step 2.6: Commit**

```bash
git add src/shared/book-notes.ts src/shared/book-notes.test.ts src/shared/ipc.ts
git commit -m "feat(notes): add book notes shared contracts and IPC channels"
```

---

### Task 3: 主进程纯函数模块（TDD）

**Files:**

- Create: `src/main/library/book-notes.ts`
- Create: `src/main/library/book-notes.test.ts`

- [ ] **Step 3.1: 写失败的仓库测试**

创建 `src/main/library/book-notes.test.ts`（镜像 `annotations.test.ts` 的 freshDb 模式）：

```ts
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { bookNotes, books } from "@main/db/schema";
import {
  createBookNote,
  deleteBookNote,
  listBookNotesByBook,
  updateBookNote,
} from "@main/library/book-notes";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  db.insert(books).values({ id: "book-1" }).run();
  return db;
}

describe("book notes repository", () => {
  it("creates and lists by book", () => {
    const db = freshDb();
    const n = createBookNote(db, { bookId: "book-1", content: "# 读后感" });
    expect(n.id).toBeTruthy();
    expect(n.content).toBe("# 读后感");
    expect(listBookNotesByBook(db, "book-1").map((x) => x.id)).toEqual([n.id]);
  });

  it("lists most-recently-created first", () => {
    const db = freshDb();
    const a = createBookNote(db, { bookId: "book-1", content: "first" });
    const b = createBookNote(db, { bookId: "book-1", content: "second" });
    // 强制不同 createdAt，避免同毫秒插入导致顺序不确定。
    db.update(bookNotes).set({ createdAt: 1 }).where(eq(bookNotes.id, a.id)).run();
    db.update(bookNotes).set({ createdAt: 2 }).where(eq(bookNotes.id, b.id)).run();
    expect(listBookNotesByBook(db, "book-1").map((x) => x.id)).toEqual([b.id, a.id]);
  });

  it("updates content and refreshes updatedAt", () => {
    const db = freshDb();
    const n = createBookNote(db, { bookId: "book-1", content: "old" });
    // 把 updatedAt 拨回过去，确保 update 后严格变大（不依赖毫秒间隔）。
    db.update(bookNotes).set({ updatedAt: 1 }).where(eq(bookNotes.id, n.id)).run();
    const u = updateBookNote(db, { id: n.id, patch: { content: "new **md**" } });
    expect(u.content).toBe("new **md**");
    expect(u.updatedAt).toBeGreaterThan(1);
  });

  it("throws for unknown note on update", () => {
    const db = freshDb();
    expect(() =>
      updateBookNote(db, { id: "00000000-0000-0000-0000-000000000000", patch: { content: "x" } }),
    ).toThrow(/book note .* not found/);
  });

  it("deletes", () => {
    const db = freshDb();
    const n = createBookNote(db, { bookId: "book-1", content: "bye" });
    deleteBookNote(db, n.id);
    expect(listBookNotesByBook(db, "book-1")).toEqual([]);
  });

  it("throws for unknown note on delete", () => {
    const db = freshDb();
    expect(() => deleteBookNote(db, "no-such")).toThrow(/book note .* not found/);
  });

  it("throws for unknown book on create", () => {
    const db = freshDb();
    expect(() => createBookNote(db, { bookId: "no-such", content: "x" })).toThrow(
      /book .* not found/,
    );
  });

  it("cascades on book delete", () => {
    const db = freshDb();
    createBookNote(db, { bookId: "book-1", content: "will vanish" });
    db.delete(books).where(eq(books.id, "book-1")).run();
    expect(db.select().from(bookNotes).all()).toEqual([]);
  });
});
```

- [ ] **Step 3.2: 跑测试确认失败**

```bash
pnpm test src/main/library/book-notes.test.ts
```

Expected: FAIL（模块 `@main/library/book-notes` 不存在）。

- [ ] **Step 3.3: 实现 main/library/book-notes.ts**

```ts
import { desc, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { bookNotes, books } from "@main/db/schema";
import type { BookNoteDto, CreateBookNoteInput, UpdateBookNoteInput } from "@shared/book-notes";

type BookNoteRow = typeof bookNotes.$inferSelect;

function toDto(row: BookNoteRow): BookNoteDto {
  return {
    id: row.id,
    bookId: row.bookId,
    content: row.content,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 列出某书的全部笔记（按 createdAt 降序，最近创建在前；此即渲染层的展示顺序）。 */
export function listBookNotesByBook(db: DB, bookId: string): BookNoteDto[] {
  return db
    .select()
    .from(bookNotes)
    .where(eq(bookNotes.bookId, bookId))
    .orderBy(desc(bookNotes.createdAt))
    .all()
    .map(toDto);
}

/** 建笔记；缺书抛可读错误（镜像 createAnnotation 的 FK 预检）。 */
export function createBookNote(db: DB, input: CreateBookNoteInput): BookNoteDto {
  const book = db.select({ id: books.id }).from(books).where(eq(books.id, input.bookId)).get();
  if (!book) throw new Error(`createBookNote: book ${input.bookId} not found`);
  const row = db
    .insert(bookNotes)
    .values({ bookId: input.bookId, content: input.content })
    .returning()
    .get();
  return toDto(row);
}

/** 改内容并刷新 updatedAt；缺行抛可读错误。 */
export function updateBookNote(db: DB, input: UpdateBookNoteInput): BookNoteDto {
  const row = db
    .update(bookNotes)
    .set({ content: input.patch.content, updatedAt: Date.now() })
    .where(eq(bookNotes.id, input.id))
    .returning()
    .get();
  if (!row) throw new Error(`updateBookNote: book note ${input.id} not found`);
  return toDto(row);
}

/** 删笔记；缺行抛可读错误。 */
export function deleteBookNote(db: DB, id: string): void {
  const res = db.delete(bookNotes).where(eq(bookNotes.id, id)).run();
  if (res.changes === 0) throw new Error(`deleteBookNote: book note ${id} not found`);
}
```

- [ ] **Step 3.4: 跑测试确认通过**

```bash
pnpm test src/main/library/book-notes.test.ts
```

Expected: 8 个测试全 PASS。

- [ ] **Step 3.5: Commit**

```bash
git add src/main/library/book-notes.ts src/main/library/book-notes.test.ts
git commit -m "feat(notes): add book notes repository module"
```

---

### Task 4: IPC handlers + preload + 注册

**Files:**

- Create: `src/main/ipc/book-notes-handlers.ts`
- Modify: `src/main.ts`（import 区 + handler 注册区）
- Modify: `src/preload-api.ts`（`annotations` 块之后）

- [ ] **Step 4.1: 写 handlers 文件**

创建 `src/main/ipc/book-notes-handlers.ts`：

```ts
// src/main/ipc/book-notes-handlers.ts
import { C } from "@shared/ipc";
import { getDb } from "@main/db/instance";
import {
  createBookNote,
  deleteBookNote,
  listBookNotesByBook,
  updateBookNote,
} from "@main/library/book-notes";
import { bind, register, type Binding } from "@main/ipc/registry";

export const bookNotesBindings: Binding[] = [
  bind(C.bookNotesListByBook, (input) => listBookNotesByBook(getDb(), input.bookId)),
  bind(C.bookNotesCreate, (input) => createBookNote(getDb(), input)),
  bind(C.bookNotesUpdate, (input) => updateBookNote(getDb(), input)),
  bind(C.bookNotesDelete, (input) => deleteBookNote(getDb(), input.id)),
];

export function registerBookNotesHandlers(): void {
  register(bookNotesBindings);
}
```

- [ ] **Step 4.2: 在 main.ts 注册**

`src/main.ts`：`registerAnnotationHandlers` import 行（L17 附近）之后加：

```ts
import { registerBookNotesHandlers } from "@main/ipc/book-notes-handlers";
```

`registerAnnotationHandlers();` 调用行（L150 附近）之后加：

```ts
registerBookNotesHandlers();
```

- [ ] **Step 4.3: 在 preload-api.ts 挂 window.api.bookNotes**

`createApi` 返回对象中 `annotations: {...},` 块之后加：

```ts
    bookNotes: {
      listByBook: inv(C.bookNotesListByBook),
      create: inv(C.bookNotesCreate),
      update: inv(C.bookNotesUpdate),
      delete: inv(C.bookNotesDelete),
    },
```

- [ ] **Step 4.4: 跑全量测试 + typecheck**

```bash
pnpm test && pnpm typecheck
```

Expected: 全 PASS（preload 契约漂移测试会自动覆盖新通道——invoker 携带 `__channel` 供走树收集）；typecheck 无错误。

- [ ] **Step 4.5: Commit**

```bash
git add src/main/ipc/book-notes-handlers.ts src/main.ts src/preload-api.ts
git commit -m "feat(notes): wire book notes IPC handlers and preload API"
```

---

### Task 5: 渲染层 query key 与查询工厂

**Files:**

- Modify: `src/renderer/query/keys.ts`
- Create: `src/renderer/query/book-note-queries.ts`

- [ ] **Step 5.1: keys.ts 加 bookNotes 键**

在 `qk` 对象的 `annotations` 行后加：

```ts
  bookNotes: (bookId: string) => ["book-notes", bookId] as const,
```

- [ ] **Step 5.2: 写查询工厂**

创建 `src/renderer/query/book-note-queries.ts`：

```ts
// src/renderer/query/book-note-queries.ts
import type { BookNoteDto } from "@shared/book-notes";
import { qk } from "@renderer/query/keys";

/** 书籍笔记列表 query（侧栏 tab 与书库 Dialog 共用）。无主进程后台推进，默认 staleTime 即可。 */
export function bookNotesQuery(bookId: string) {
  return {
    queryKey: qk.bookNotes(bookId),
    queryFn: (): Promise<BookNoteDto[]> => window.api.bookNotes.listByBook({ bookId }),
  } as const;
}
```

- [ ] **Step 5.3: typecheck + commit**

```bash
pnpm typecheck
git add src/renderer/query/keys.ts src/renderer/query/book-note-queries.ts
git commit -m "feat(notes): add book notes query key and factory"
```

---

### Task 6: BookNoteEditorDialog 组件

**Files:**

- Create: `src/renderer/book-notes/BookNoteEditorDialog.tsx`

- [ ] **Step 6.1: 写组件**

镜像 `NoteModal.tsx` 的交互契约（打开即聚焦、⌘/Ctrl+Enter 保存、ESC/遮罩关闭），但受控于 props 而非 store（panel 是双挂载点共享组件，不进全局 store）：

```tsx
import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { CornerDownLeft } from "lucide-react";
import { Kbd, KbdGroup, ModKey } from "@renderer/components/ui/kbd";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Textarea } from "@renderer/components/ui/textarea";
import { Button } from "@renderer/components/ui/button";

export type BookNoteEditorState =
  | { mode: "create" }
  | { mode: "edit"; noteId: string; initialContent: string };

/** 居中笔记编辑 Dialog（新建/编辑共用）；书库场景下叠在笔记列表 Dialog 之上（Base UI 支持嵌套）。 */
export function BookNoteEditorDialog({
  state,
  onSave,
  onClose,
}: {
  /** null = 关闭。每次打开传新对象（保证初始化 effect 重跑）。 */
  state: BookNoteEditorState | null;
  /** 保存回调；只会收到 trim 后非空的 content。edit 模式的 noteId 由调用方从 state 取。 */
  onSave: (content: string) => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState("");

  // 打开时初始化文本 + 聚焦（state 每次打开均为新对象引用，effect 必重跑、文本必重置）。
  useEffect(() => {
    if (!state) return;
    setText(state.mode === "edit" ? state.initialContent : "");
    taRef.current?.focus();
  }, [state]);

  if (!state) return null;

  const save = () => {
    const content = text.trim();
    if (!content) return;
    onSave(content);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <DialogContent className="font-sans sm:max-w-[36rem]">
        <DialogHeader>
          <DialogTitle>
            {state.mode === "edit"
              ? t("bookNotes.editTitle", "编辑笔记")
              : t("bookNotes.addTitle", "新建笔记")}
          </DialogTitle>
        </DialogHeader>
        <Textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            // Cmd(macOS)/Ctrl(Win/Linux)+Enter 保存
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              save();
            }
          }}
          placeholder={t("bookNotes.placeholder", "写点对这本书的想法…")}
          className="no-scrollbar min-h-55 resize-none leading-relaxed"
        />
        <p className="text-xs text-muted-foreground">
          {t("bookNotes.markdownHint", "支持 Markdown，保存后渲染")}
        </p>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose}>
            {t("common.cancel", "取消")}
          </Button>
          <Button onClick={save} disabled={text.trim() === ""}>
            {t("common.save", "保存")}
            <KbdGroup>
              <ModKey className="border-transparent bg-primary-foreground/20 text-primary-foreground" />
              <Kbd className="border-transparent bg-primary-foreground/20 text-primary-foreground">
                <CornerDownLeft className="size-3" />
              </Kbd>
            </KbdGroup>
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 6.2: typecheck + commit**

```bash
pnpm typecheck
git add src/renderer/book-notes/BookNoteEditorDialog.tsx
git commit -m "feat(notes): add book note editor dialog"
```

---

### Task 7: BookNotesPanel 组件

**Files:**

- Create: `src/renderer/book-notes/BookNotesPanel.tsx`

- [ ] **Step 7.1: 写组件**

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Pencil, Plus, Trash2 } from "lucide-react";
import type { BookNoteDto } from "@shared/book-notes";
import { Button } from "@renderer/components/ui/button";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { LocalizedStreamdown } from "@renderer/components/LocalizedStreamdown";
import { qk } from "@renderer/query/keys";
import { bookNotesQuery } from "@renderer/query/book-note-queries";
import { relativeTime } from "@renderer/lib/relative-time";
import { BookNoteEditorDialog, type BookNoteEditorState } from "./BookNoteEditorDialog";

/** 书籍级独立笔记面板：侧栏「笔记」tab 与书库「查看笔记」Dialog 渲染同一实例形态。 */
export function BookNotesPanel({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const notes = useQuery(bookNotesQuery(bookId));
  const [editor, setEditor] = useState<BookNoteEditorState | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const invalidate = () => qc.invalidateQueries({ queryKey: qk.bookNotes(bookId) });
  const createM = useMutation({ mutationFn: window.api.bookNotes.create, onSuccess: invalidate });
  const updateM = useMutation({ mutationFn: window.api.bookNotes.update, onSuccess: invalidate });
  const deleteM = useMutation({ mutationFn: window.api.bookNotes.delete, onSuccess: invalidate });

  const save = (content: string) => {
    if (editor?.mode === "edit") updateM.mutate({ id: editor.noteId, patch: { content } });
    else createM.mutate({ bookId, content });
  };

  return (
    <div className="flex h-full flex-col">
      <div className="shrink-0 p-2 pb-0">
        <Button
          variant="outline"
          size="sm"
          className="w-full"
          onClick={() => setEditor({ mode: "create" })}
        >
          <Plus />
          {t("bookNotes.add", "新建笔记")}
        </Button>
      </div>
      <div className="min-h-0 flex-1">
        {notes.isPending ? (
          <p className="p-3 text-sm text-muted-foreground">{t("bookNotes.loading", "加载笔记…")}</p>
        ) : notes.isError ? (
          <p className="p-3 text-sm text-destructive">{t("bookNotes.loadError", "笔记加载失败")}</p>
        ) : (notes.data?.length ?? 0) === 0 ? (
          <p className="p-4 text-center text-xs text-muted-foreground">
            {t("bookNotes.empty", "还没有笔记。写下对这本书的第一条想法吧～")}
          </p>
        ) : (
          <ScrollArea className="h-full">
            <div className="space-y-1.5 p-2">
              {notes.data!.map((n) => (
                <NoteItem
                  key={n.id}
                  note={n}
                  onEdit={() =>
                    setEditor({ mode: "edit", noteId: n.id, initialContent: n.content })
                  }
                  onDelete={() => setConfirmDeleteId(n.id)}
                />
              ))}
            </div>
          </ScrollArea>
        )}
      </div>

      <BookNoteEditorDialog state={editor} onSave={save} onClose={() => setEditor(null)} />

      <AlertDialog
        open={confirmDeleteId != null}
        onOpenChange={(open) => {
          if (!open) setConfirmDeleteId(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogTitle>
            {t("bookNotes.deleteConfirm.title", "删除这条笔记？")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t("bookNotes.deleteConfirm.body", "此操作不可撤销。")}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirmDeleteId(null)}>
              {t("common.cancel", "取消")}
            </Button>
            <Button
              variant="destructive"
              onClick={() => {
                if (confirmDeleteId) deleteM.mutate({ id: confirmDeleteId });
                setConfirmDeleteId(null);
              }}
            >
              {t("bookNotes.deleteConfirm.confirm", "删除")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function NoteItem({
  note,
  onEdit,
  onDelete,
}: {
  note: BookNoteDto;
  onEdit: () => void;
  onDelete: () => void;
}) {
  const { t, i18n } = useTranslation();
  return (
    <div className="group rounded-lg border border-border bg-background/60 p-2.5">
      <div className="text-xs leading-relaxed">
        <LocalizedStreamdown>{note.content}</LocalizedStreamdown>
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground/70">
          {relativeTime(note.createdAt, Date.now(), i18n.language)}
        </span>
        <span className="flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-100">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("bookNotes.edit", "编辑")}
            onClick={onEdit}
            className="text-muted-foreground"
          >
            <Pencil className="size-3.5" />
          </Button>
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label={t("bookNotes.delete", "删除")}
            onClick={onDelete}
            className="text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="size-3.5" />
          </Button>
        </span>
      </div>
    </div>
  );
}
```

- [ ] **Step 7.2: typecheck + commit**

```bash
pnpm typecheck
git add src/renderer/book-notes/BookNotesPanel.tsx
git commit -m "feat(notes): add shared book notes panel"
```

---

### Task 8: 阅读器侧栏挂第 4 个 tab

**Files:**

- Modify: `src/renderer/reader/Sidebar.tsx`

- [ ] **Step 8.1: 加 tab**

imports 改为（新增 `NotebookPen` 与 `BookNotesPanel`）：

```tsx
import { List, Highlighter, MessagesSquare, NotebookPen } from "lucide-react";
import { BookNotesPanel } from "@renderer/book-notes/BookNotesPanel";
```

`TabsList` 内、`conversations` trigger 之后加：

```tsx
<TabsTrigger value="book-notes" className="group/tab" aria-label={t("reader.bookNotes", "笔记")}>
  <NotebookPen />
  <span className="hidden group-data-[active]/tab:inline">{t("reader.bookNotes", "笔记")}</span>
</TabsTrigger>
```

`TabsContent value="conversations"` 之后加：

```tsx
<TabsContent value="book-notes" className="min-h-0 overflow-hidden">
  <BookNotesPanel bookId={bookId} />
</TabsContent>
```

（现有「标注」tab 的 `value="notes"` 保持不动。）

- [ ] **Step 8.2: typecheck + commit**

```bash
pnpm typecheck
git add src/renderer/reader/Sidebar.tsx
git commit -m "feat(notes): mount book notes tab in reader sidebar"
```

---

### Task 9: 书库书卡右键入口 + Dialog

**Files:**

- Modify: `src/renderer/library/BookCover.tsx`

- [ ] **Step 9.1: 加「查看笔记」菜单项与 Dialog**

imports：lucide 行加 `NotebookPen`，并新增：

```tsx
import { BookNotesPanel } from "@renderer/book-notes/BookNotesPanel";
```

组件内加 state（`editOpen` 之后）：

```tsx
const [notesOpen, setNotesOpen] = useState(false);
```

`ContextMenuContent` 内、「编辑信息」项之后、「删除」项之前加：

```tsx
<ContextMenuItem onClick={() => setNotesOpen(true)}>
  <NotebookPen />
  {t("library.menu.notes", "查看笔记")}
</ContextMenuItem>
```

组件 JSX 末尾（编辑信息 Dialog 之后）加笔记 Dialog——`BookNotesPanel` 内部用 `h-full` 布局，Dialog 里给固定高度容器：

```tsx
<Dialog open={notesOpen} onOpenChange={setNotesOpen}>
  <DialogContent className="font-sans sm:max-w-lg">
    <DialogHeader>
      <DialogTitle>{t("library.notesDialog.title", "笔记 · {{title}}", { title })}</DialogTitle>
    </DialogHeader>
    <div className="h-[60vh]">
      <BookNotesPanel bookId={book.id} />
    </div>
  </DialogContent>
</Dialog>
```

- [ ] **Step 9.2: typecheck + commit**

```bash
pnpm typecheck
git add src/renderer/library/BookCover.tsx
git commit -m "feat(notes): add view-notes entry on library book card"
```

---

### Task 10: i18n、全量验证、changeset

**Files:**

- Modify: `src/shared/i18n/locales/**`（由 extract 生成/同步）
- Create: `.changeset/<generated>.md`

- [ ] **Step 10.1: 抽取 i18n key 并检查**

```bash
pnpm i18n:extract && pnpm i18n:lint
```

Expected: 新增 `bookNotes.*`、`reader.bookNotes`、`library.menu.notes`、`library.notesDialog.title` 等 key 落入 locales；lint 无缺漏。检查非主语言（en）新 key 是否需要补译——en 文案：

| key                               | en                                                      |
| --------------------------------- | ------------------------------------------------------- |
| `reader.bookNotes`                | Notes                                                   |
| `bookNotes.add`                   | New note                                                |
| `bookNotes.addTitle`              | New note                                                |
| `bookNotes.editTitle`             | Edit note                                               |
| `bookNotes.placeholder`           | Write down your thoughts about this book…               |
| `bookNotes.markdownHint`          | Markdown supported, rendered after saving               |
| `bookNotes.loading`               | Loading notes…                                          |
| `bookNotes.loadError`             | Failed to load notes                                    |
| `bookNotes.empty`                 | No notes yet. Write your first thought about this book! |
| `bookNotes.edit`                  | Edit                                                    |
| `bookNotes.delete`                | Delete                                                  |
| `bookNotes.deleteConfirm.title`   | Delete this note?                                       |
| `bookNotes.deleteConfirm.body`    | This action cannot be undone.                           |
| `bookNotes.deleteConfirm.confirm` | Delete                                                  |
| `library.menu.notes`              | View notes                                              |
| `library.notesDialog.title`       | Notes · {{title}}                                       |

- [ ] **Step 10.2: 全量验证**

```bash
pnpm typecheck && pnpm lint && pnpm test
```

Expected: 全绿。

- [ ] **Step 10.3: 写 changeset**

```bash
pnpm changeset
```

类型 minor；英文条目：

```
Add standalone book-level notes: write multiple Markdown notes per book from the reader sidebar's new Notes tab, or review them from the library via right-click → View notes — no text selection required.
```

- [ ] **Step 10.4: Commit**

```bash
git add src/shared/i18n .changeset
git commit -m "feat(notes): add i18n strings and changeset for book notes"
```

---

### Task 11: 冒烟验证（手动 / CDP）

**Files:** 无（验证步骤）

- [ ] **Step 11.1: 启动 dev 并冒烟两个入口**

```bash
pnpm start
```

清单（CDP 或手动）：

1. 打开一本书 → 侧栏出现第 4 个「笔记」tab → 新建一条含 Markdown（`**bold**` + 列表）的笔记 → 保存后卡片渲染为富文本
2. 编辑该笔记 → Dialog 预填原文 → ⌘+Enter 保存 → 列表更新
3. 删除 → AlertDialog 确认 → 列表清空显示空态
4. 回书库 → 书卡右键「查看笔记」→ Dialog 列出同一批笔记，可新建/编辑/删除
5. 中英文切换 → 文案正常

Expected: 全部通过；任何渲染层报错以 DevTools console + `userData/logs` 为准。

- [ ] **Step 11.2: 完成后走 finishing 流程**

实现完毕、全部验证通过后，使用 superpowers:finishing-a-development-branch skill（rebase 合回 main、检查 kanban #79 挪 Done、commit message 带 `closes #79`）。

---

## Self-Review 记录

- **Spec 覆盖**：数据层（Task 1）、共享契约（Task 2）、主进程（Task 3/4）、query（Task 5）、编辑 Dialog（Task 6）、Panel（Task 7）、两个挂载点（Task 8/9）、i18n/测试/changeset（Task 10）、冒烟（Task 11）——spec 各节均有对应任务。范围外条目无任务，符合预期。
- **占位符**：所有代码步骤均给出完整代码；无 TBD/「类似 Task N」。
- **类型一致性**：`BookNoteEditorState` 在 Task 6 定义、Task 7 消费，字段名一致；`bookNotesQuery`/`qk.bookNotes` 命名在 Task 5/7 一致；IPC 契约名 `C.bookNotes*` 在 Task 2/4 一致。
