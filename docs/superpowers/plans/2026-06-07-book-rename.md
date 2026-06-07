# 书籍信息编辑（#29）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 书库卡片右键菜单加「编辑信息」，双字段 Dialog 编辑书名/作者并持久化到 `books.title`/`books.author`（closes #29）。

**Architecture:** 沿 IPC 脊柱五层各加一小块：Zod schema（shared）→ 纯函数 `updateBook`（repository）→ `bind` 胶水（handlers）→ preload 一行 → renderer Dialog + mutation。零 DB 迁移。设计真相源：`docs/superpowers/specs/2026-06-07-book-rename-design.md`。

**Tech Stack:** Zod 4 / Drizzle（better-sqlite3）/ React 19 + Base UI Dialog / TanStack Query / i18next / vitest 4。

**约定提醒：**

- 测试跑在 Electron 运行时：`pnpm test <file>`（勿用裸 vitest）。
- pre-commit hook 可能改文件并中止提交：重新 `git add` 后**原样重跑同一条 commit 命令**即可。
- 渲染层启用 React Compiler：**不要**手写 `useCallback`/`useMemo`。
- 本仓库在 worktree `feat/book-rename` 分支上工作，勿切分支。

---

### Task 1: shared schema `updateBookInput`

**Files:**

- Modify: `src/shared/library.ts`（在 `bookIdInput` 之后加 schema）
- Create: `src/shared/library.test.ts`

- [ ] **Step 1: 写失败测试**

新建 `src/shared/library.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { updateBookInput } from "@shared/library";

describe("updateBookInput", () => {
  it("accepts valid input and trims fields", () => {
    const r = updateBookInput.parse({ bookId: "b1", title: "  Clean  ", author: "  A  " });
    expect(r.title).toBe("Clean");
    expect(r.author).toBe("A");
  });

  it("accepts null author (explicit clear)", () => {
    const r = updateBookInput.parse({ bookId: "b1", title: "T", author: null });
    expect(r.author).toBeNull();
  });

  it("rejects empty or whitespace-only title", () => {
    expect(updateBookInput.safeParse({ bookId: "b", title: "", author: null }).success).toBe(false);
    expect(updateBookInput.safeParse({ bookId: "b", title: "   ", author: null }).success).toBe(
      false,
    );
  });

  it("rejects missing author key (put semantics, not patch)", () => {
    expect(updateBookInput.safeParse({ bookId: "b", title: "T" }).success).toBe(false);
  });

  it("rejects empty-string author (renderer coerces '' to null before send)", () => {
    expect(updateBookInput.safeParse({ bookId: "b", title: "T", author: "" }).success).toBe(false);
  });

  it("rejects overlong fields", () => {
    const long = "x".repeat(501);
    expect(updateBookInput.safeParse({ bookId: "b", title: long, author: null }).success).toBe(
      false,
    );
    expect(updateBookInput.safeParse({ bookId: "b", title: "T", author: long }).success).toBe(
      false,
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/shared/library.test.ts`
Expected: FAIL（`updateBookInput` 未导出）

- [ ] **Step 3: 实现 schema**

`src/shared/library.ts` 在 `bookIdInput`/`BookIdInput`（第 6-7 行）之后插入：

```ts
/** #29 书籍信息编辑。put 语义：两字段必传；author=null 显式清空（回「未知作者」显示）。空串收敛（""→null）由 renderer 表单完成，此处 min(1) 拒空串防绕过 UI 的脏输入。 */
export const updateBookInput = z.object({
  bookId: z.string().min(1),
  title: z.string().trim().min(1).max(500),
  author: z.string().trim().min(1).max(500).nullable(),
});
export type UpdateBookInput = z.infer<typeof updateBookInput>;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/shared/library.test.ts`
Expected: PASS（6 个用例全绿）

- [ ] **Step 5: Commit**

```bash
git add src/shared/library.ts src/shared/library.test.ts
git commit -m "feat(shared): add updateBookInput schema for book metadata edit (#29)"
```

---

### Task 2: 主进程纯函数 `updateBook` + 修正 schema 列注释

**Files:**

- Modify: `src/main/library/repository.ts`（在 `importBook` 之前、`detectFormat` 之后的位置加函数；任意稳定位置均可，建议放 `listBooks`/`getBook` 附近的查询函数区）
- Modify: `src/main/db/schema.ts:55`（仅注释）
- Test: `src/main/library/repository.test.ts`

- [ ] **Step 1: 写失败测试**

`src/main/library/repository.test.ts`：在文件顶部 `from "@main/library/repository"` 的 import 列表中加入 `updateBook`，并在 `describe("library repository", ...)` 块内追加：

```ts
describe("updateBook", () => {
  it("updates title and author and persists", async () => {
    const db = freshDb();
    const book = await importBook(db, { bytes: makeFixtureEpub() });
    const updated = updateBook(db, {
      bookId: book.id,
      title: "Clean Title",
      author: "Real Author",
    });
    expect(updated.title).toBe("Clean Title");
    expect(updated.author).toBe("Real Author");
    const row = db.select().from(books).where(eq(books.id, book.id)).get()!;
    expect(row.title).toBe("Clean Title");
    expect(row.author).toBe("Real Author");
  });

  it("clears author with null", async () => {
    const db = freshDb();
    const book = await importBook(db, { bytes: makeFixtureEpub() });
    updateBook(db, { bookId: book.id, title: "T", author: null });
    const row = db.select().from(books).where(eq(books.id, book.id)).get()!;
    expect(row.author).toBeNull();
  });

  it("throws for unknown book id", () => {
    const db = freshDb();
    expect(() => updateBook(db, { bookId: "nope", title: "X", author: null })).toThrow(/not found/);
  });

  it("does not touch other columns", async () => {
    const db = freshDb();
    const book = await importBook(db, { bytes: makeFixtureEpub() });
    const before = db.select().from(books).where(eq(books.id, book.id)).get()!;
    updateBook(db, { bookId: book.id, title: "New", author: null });
    const after = db.select().from(books).where(eq(books.id, book.id)).get()!;
    expect(after.cover).toEqual(before.cover);
    expect(after.toc).toEqual(before.toc);
    expect(after.format).toBe(before.format);
    expect(after.summary).toBe(before.summary);
  });
});
```

（`importBook`、`makeFixtureEpub`、`books`、`eq`、`freshDb` 在该测试文件中均已存在。新 `describe` 与文件中既有的顶层 `describe("library repository")` 并列即可。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/library/repository.test.ts`
Expected: FAIL（`updateBook` 未导出）；既有用例不受影响保持绿

- [ ] **Step 3: 实现 `updateBook`**

`src/main/library/repository.ts` 加导出函数（drizzle `.returning().get()` 模式有先例，见 `src/main/providers/repository.ts:105`）：

```ts
/**
 * 更新书名/作者（#29）。put 语义：author=null 显式清空。
 * 注：导入幂等是 early return（见 importBook），重导同一文件不会触碰已有行——手动修改不会被解析元数据冲掉。
 */
export function updateBook(
  db: DB,
  input: { bookId: string; title: string; author: string | null },
): BookRow {
  const row = db
    .update(books)
    .set({ title: input.title, author: input.author })
    .where(eq(books.id, input.bookId))
    .returning()
    .get();
  if (!row) throw new Error(`library: book ${input.bookId} not found`);
  return row;
}
```

- [ ] **Step 4: 修正 `schema.ts:55` 过时列注释**

`src/main/db/schema.ts:55` 当前为：

```ts
    id: text("id").primaryKey(), // ePub 自然键，由导入流程提供（标识符缺失时回退文件哈希）
```

改为（统一 id 为 contentHash 的议题另记 #50，本次只修文档）：

```ts
    id: text("id").primaryKey(), // 内容稳定 ID：ePub 取 dc:identifier（缺失回退文件哈希）；PDF 恒为文件哈希（#50 记有统一议题）
```

- [ ] **Step 5: 跑测试确认通过**

Run: `pnpm test src/main/library/repository.test.ts`
Expected: PASS（新增 4 用例 + 既有用例全绿）

- [ ] **Step 6: Commit**

```bash
git add src/main/library/repository.ts src/main/library/repository.test.ts src/main/db/schema.ts
git commit -m "feat(main): add updateBook repository function (#29)"
```

---

### Task 3: IPC 通道 + 胶水 + preload（一个任务完成，避免 bindings-coverage 中间红）

**Files:**

- Modify: `src/shared/ipc.ts`（library 段，`libraryDelete` 之后）
- Modify: `src/main/ipc/library-handlers.ts`
- Modify: `src/preload-api.ts`（library 段）

**注意：** `bindings-coverage.test.ts` 断言「invoke 通道 ↔ binding 双向相等」，所以通道 def 与 binding 必须同一提交落地，否则全量测试红。

- [ ] **Step 1: 注册通道**

`src/shared/ipc.ts`：

1. 在文件顶部已有的 `from "@shared/library"` import 列表中加入 `updateBookInput`（两个 import 块都引了 `@shared/library`，加进含 `bookIdInput` 的那个）。
2. library 段 `libraryDelete`（约 116 行）之后加：

```ts
  libraryUpdate: def("library:update", "invoke", updateBookInput, out<BookSummaryDto>()),
```

- [ ] **Step 2: 加 handler binding**

`src/main/ipc/library-handlers.ts`：

1. 顶部 `from "@main/library/repository"` 的 import 列表加 `updateBook`。
2. `libraryBindings` 数组中 `bind(C.libraryDelete, ...)` 之后加：

```ts
  bind(C.libraryUpdate, (input) => {
    const book = updateBook(getDb(), input);
    return toDto({ ...book, hasCover: book.cover != null && book.cover.length > 0 });
  }),
```

（`toDto`、`getDb` 该文件已有；input 类型由 contract 自动推导。handler 抛错由 `registry.ts` catch-all 落盘，无需手动记日志。）

- [ ] **Step 3: 加 preload invoker**

`src/preload-api.ts` library 段（`delete: inv(C.libraryDelete),` 之后）加：

```ts
      update: inv(C.libraryUpdate),
```

- [ ] **Step 4: 全量验证**

Run: `pnpm test && pnpm typecheck`
Expected: 全绿。两套覆盖测试都是**自动收集**机制，无需手动修改：`bindings-coverage.test.ts` 断言通道-binding 双向相等（Step 2 满足它）；`preload-api.test.ts` 递归扫 `__channel` 标记断言 preload 暴露与 invoke 通道双向相等（Step 3 满足它）。任一步骤遗漏，对应测试会精确红出来。

- [ ] **Step 5: Commit**

```bash
git add src/shared/ipc.ts src/main/ipc/library-handlers.ts src/preload-api.ts
git commit -m "feat(ipc): wire library:update channel through registry and preload (#29)"
```

---

### Task 4: renderer——BookCover Dialog + LibraryView mutation + i18n

**Files:**

- Modify: `src/renderer/library/BookCover.tsx`
- Modify: `src/renderer/library/LibraryView.tsx`
- Modify: `src/shared/i18n/locales/zh-CN.ts`、`src/shared/i18n/locales/en.ts`

- [ ] **Step 1: BookCover 加菜单项 + 编辑 Dialog**

`src/renderer/library/BookCover.tsx` 整体改动：

新增 imports：

```ts
import { useId, useState } from "react"; // useState 已有，补 useId
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@renderer/components/ui/dialog";
import { Input } from "@renderer/components/ui/input";
import { Label } from "@renderer/components/ui/label";
```

props 加 `onUpdate`：

```ts
export function BookCover({
  book,
  onOpen,
  onDelete,
  onUpdate,
}: {
  book: BookSummaryDto;
  onOpen: () => void;
  onDelete: () => void;
  onUpdate: (patch: { title: string; author: string | null }) => void;
}) {
```

组件体新增 state 与处理函数（紧随 `confirmOpen`）：

```ts
const [editOpen, setEditOpen] = useState(false);
const [editTitle, setEditTitle] = useState("");
const [editAuthor, setEditAuthor] = useState("");
const fieldId = useId();

// 打开时从 book 快照初始化（不预填 id 哈希——哈希是 title=null 的显示回退，不是数据）。
const openEdit = () => {
  setEditTitle(book.title ?? "");
  setEditAuthor(book.author ?? "");
  setEditOpen(true);
};

const saveEdit = () => {
  const title = editTitle.trim();
  if (!title) return;
  onUpdate({ title, author: editAuthor.trim() || null }); // 空作者收敛为 null →「未知作者」
  setEditOpen(false);
};
```

`ContextMenuContent` 中 Delete 项**上方**加（destructive 项保持尾部）：

```tsx
<ContextMenuItem onClick={openEdit}>{t("library.menu.edit", "编辑信息")}</ContextMenuItem>
```

在既有 `<AlertDialog>...</AlertDialog>` 之后、`</>` 之前加编辑 Dialog（结构参考 `NoteModal.tsx`）：

```tsx
<Dialog open={editOpen} onOpenChange={setEditOpen}>
  <DialogContent className="font-sans sm:max-w-md">
    <DialogHeader>
      <DialogTitle>{t("library.editDialog.title", "编辑书籍信息")}</DialogTitle>
    </DialogHeader>
    <form
      className="flex flex-col gap-4"
      onSubmit={(e) => {
        e.preventDefault();
        saveEdit();
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${fieldId}-title`}>{t("library.editDialog.bookTitle", "书名")}</Label>
        <Input
          id={`${fieldId}-title`}
          value={editTitle}
          onChange={(e) => setEditTitle(e.target.value)}
          autoFocus
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor={`${fieldId}-author`}>{t("library.editDialog.author", "作者")}</Label>
        <Input
          id={`${fieldId}-author`}
          value={editAuthor}
          onChange={(e) => setEditAuthor(e.target.value)}
          placeholder={t("library.editDialog.authorPlaceholder", "留空则显示「未知作者」")}
        />
      </div>
      <DialogFooter>
        <Button type="button" variant="ghost" onClick={() => setEditOpen(false)}>
          {t("common.cancel", "取消")}
        </Button>
        <Button type="submit" disabled={editTitle.trim() === ""}>
          {t("common.save", "保存")}
        </Button>
      </DialogFooter>
    </form>
  </DialogContent>
</Dialog>
```

（不写 `useCallback`——React Compiler 负责记忆化。）

- [ ] **Step 2: LibraryView 加 mutation 并挂接**

`src/renderer/library/LibraryView.tsx`：

1. import 改：`import type { BookSummaryDto, UpdateBookInput } from "@shared/library";`
2. `deleteBook` mutation 之后加：

```ts
// 编辑书名/作者：成功静默（卡片即时刷新就是反馈）；失败 toast 透传主进程真实错误（honest-error）。
// qk.book(bookId) 必须一并失效——reader 侧栏 BookCard 与顶栏面包屑共用该 key，且 staleTime=∞。
const updateBook = useMutation({
  mutationFn: (input: UpdateBookInput) => window.api.library.update(input),
  onSuccess: (_r, input) => {
    void qc.invalidateQueries({ queryKey: qk.library });
    void qc.invalidateQueries({ queryKey: qk.book(input.bookId) });
  },
  onError: (e, input) => {
    toast.error(
      t("library.updateFailed", "{{title}} 保存失败：{{error}}", {
        title: input.title,
        error: (e as Error).message,
      }),
      { closeButton: true, duration: Infinity },
    );
  },
});
```

3. `<BookCover>` 挂接处加 prop：

```tsx
<BookCover
  book={b}
  onOpen={() => openBook(b.id)}
  onDelete={() => deleteBook.mutate(b)}
  onUpdate={(patch) => updateBook.mutate({ bookId: b.id, ...patch })}
/>
```

- [ ] **Step 3: 补 locale 键**

两份 locale 均按**既有字母序**插入（zh-CN：`src/shared/i18n/locales/zh-CN.ts`；en：`src/shared/i18n/locales/en.ts`）。

zh-CN（`library.duplicate` 与 `library.empty` 之间插 editDialog 组；`library.menu.delete` 后插 menu.edit；`library.unknownAuthor` 后插 updateFailed）：

```ts
  "library.editDialog.author": "作者",
  "library.editDialog.authorPlaceholder": "留空则显示「未知作者」",
  "library.editDialog.bookTitle": "书名",
  "library.editDialog.title": "编辑书籍信息",
```

```ts
  "library.menu.edit": "编辑信息",
```

```ts
  "library.updateFailed": "{{title}} 保存失败：{{error}}",
```

en（同样位置规则；en 的 duplicate 是 `duplicate_one/_other`，editDialog 组插在 `library.duplicate_other` 与 `library.empty` 之间）：

```ts
  "library.editDialog.author": "Author",
  "library.editDialog.authorPlaceholder": "Leave empty for unknown author",
  "library.editDialog.bookTitle": "Title",
  "library.editDialog.title": "Edit book details",
```

```ts
  "library.menu.edit": "Edit details",
```

```ts
  "library.updateFailed": "{{title}} failed to save: {{error}}",
```

- [ ] **Step 4: i18n extract 校验（先于 typecheck）**

Run: `pnpm i18n:extract`，然后 `git diff src/shared/i18n/locales/`
Expected: diff 为空或仅有本次新键——**若 extract 反向覆盖了任何既有键（已知坑），还原该改动并保留手写值**。再跑 `grep -c "library.editDialog" src/shared/i18n/locales/en.ts` 应为 4。

- [ ] **Step 5: 全量验证**

Run: `pnpm test && pnpm typecheck && pnpm lint`
Expected: 全绿

- [ ] **Step 6: Commit**

```bash
git add src/renderer/library/BookCover.tsx src/renderer/library/LibraryView.tsx src/shared/i18n/locales/zh-CN.ts src/shared/i18n/locales/en.ts
git commit -m "feat(renderer): add edit book details dialog to library card (#29)"
```

---

### Task 5: 手动冒烟验证

**Files:** 无代码改动；GUI 验证。

- [ ] **Step 1: 启动 dev 实例**

Run: `pnpm start`（阻塞；或后台跑。dev 用独立 `marginalia-dev` userData，不污染 prod 数据）

- [ ] **Step 2: 冒烟清单**

1. 书库任意卡片右键 → 菜单出现「编辑信息」（删除项上方）
2. 点开 → Dialog 预填当前书名/作者；title=null 的书（PDF 哈希书）**预填空而非哈希**
3. 清空书名 → 保存按钮 disabled
4. 改书名 + 作者 → 保存 → 卡片**即时**刷新新值
5. 清空作者 → 保存 → 卡片显示「未知作者」
6. 开这本书 → reader 侧栏书卡与顶栏面包屑显示新书名（qk.book 失效生效）
7. 重启 app → 改动仍在（持久化）

（可选自动化：CDP 冒烟须 `connectOverCDP` 传 ws URL，传参恰好一个 `--`，见既有冒烟脚本惯例。）

- [ ] **Step 3: 收尾**

冒烟通过后，由 finishing 流程处理：changeset（用户可见功能，须写英文 changelog 条目）、合并、kanban #29 挪列。

---

## 完成定义

- [ ] `pnpm test`、`pnpm typecheck`、`pnpm lint` 全绿
- [ ] 冒烟清单 7 项全过
- [ ] commit 含 `closes #29`（最终合并提交或 changeset 提交带上）
