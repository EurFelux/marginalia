# RA3 标注与笔记 + M-b 持久化 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在真实 ePub 上落地多色高亮 / 下划线 + 段内便签：主进程持久化（annotations 表 + IPC），渲染层 CFI 高亮渲染 + 点击编辑 + 笔记 modal + 侧栏标注列表。

**Architecture:** M-b 主进程加 `annotations` 表 + repository（纯函数，headless 测）+ IPC。渲染层用 RA1-full 已捕获的 `SelectionInfo.cfiRange` 当锚点；高亮以内联 `<mark class="anno anno-{style}" data-anno-id>` 注入 iframe（CFI→`EpubCFI.toRange(doc)`，`ignoreClass:"anno"` 防 CFI 污染），`@marginalia/virtual-docs` 加通用 `decorate`/`onHighlightClick`/`redecorate` 钩子。UI 仿 Apple Books：主工具栏「高亮标记/添加笔记」入口 → 二级样式工具栏（5 色 + 下划线）/ 笔记 modal。annotations 走 TanStack Query 单源。

**Tech Stack:** Electron 41 主进程 + Drizzle/better-sqlite3 + Zod 4；React 19（React Compiler 已启用，**勿手写 useCallback/useMemo**）+ TanStack Query + zustand；epubjs `EpubCFI`（toRange/compare/spinePos）；`@marginalia/virtual-docs`；vitest（headless 主进程）。

**前置（已就绪）：** `SelectionInfo.cfiRange`（RA1-full onSelect 已写）；`epub-book` 的 `cfiFromRange`/`cfiAtIndex`/`indexOfCfi`/`hrefAtIndex`；`chapterIdByHref`；`prefsToCss`/styleCss 注入；`SectionFrame` iframe srcdoc 渲染 + `toViewportRect`。

> **关键约束**：高亮 `<mark>` 在 sandboxed iframe（srcdoc）内，**主应用 Tailwind 不生效**——高亮配色须作为 CSS 串注入 iframe（附到 `styleCss`）。工具栏色点 / 列表色条在主文档内，用 Tailwind。

---

## 文件结构

| 文件                                            | 责任                                                  | 改动   |
| ----------------------------------------------- | ----------------------------------------------------- | ------ |
| `src/main/db/schema.ts`                         | `annotations` 表                                      | Modify |
| `src/main/db/migrations/<new>/`                 | 迁移（`pnpm db:generate`）                            | Create |
| `src/shared/annotations.ts`                     | Zod + DTO + `AnnotationStyle`                         | Create |
| `src/shared/ipc.ts`                             | `annotations:*` 通道常量                              | Modify |
| `src/main/library/annotations.ts` (+`.test.ts`) | repository 纯函数 + headless 测                       | Create |
| `src/main/ipc/annotations-handlers.ts`          | 注册 handler                                          | Create |
| `src/main.ts`                                   | `registerAnnotationHandlers()`                        | Modify |
| `src/preload.ts`                                | `window.api.annotations.*`                            | Modify |
| `src/renderer/reader/epub-book.ts`              | CFI API 加 `ignoreClass` + `rangeFromCfi`             | Modify |
| `packages/virtual-docs/src/SectionFrame.tsx`    | `decorate`/`onHighlightClick`/`decorateNonce`         | Modify |
| `packages/virtual-docs/src/VirtualDocs.tsx`     | 透传 + `redecorate()`                                 | Modify |
| `src/renderer/reader/highlight.ts`              | 6 样式映射 + `ANNO_IFRAME_CSS`                        | Create |
| `src/renderer/query/keys.ts`                    | `qk.annotations(bookId)`                              | Modify |
| `src/renderer/store/reader-store.ts`            | `styleBar`/`noteModal`/`scrollToCfi` UI 态            | Modify |
| `src/renderer/reader/apply-annotations.ts`      | CFI→mark 包裹 + 清除                                  | Create |
| `src/renderer/reader/EpubReader.tsx`            | annotations query + decorate + 点击 + styleCss + 跳转 | Modify |
| `src/renderer/reader/SelectionToolbar.tsx`      | 高亮标记 / 添加笔记 入口                              | Modify |
| `src/renderer/reader/HighlightStyleBar.tsx`     | 二级样式工具栏（新）                                  | Create |
| `src/renderer/reader/NoteModal.tsx`             | 笔记 modal（新）                                      | Create |
| `src/renderer/reader/AnnotationsList.tsx`       | 侧栏标注列表（新）                                    | Create |
| `src/renderer/reader/Sidebar.tsx`               | 目录/标注 页签容器（新）                              | Create |
| `src/renderer/reader/ReaderView.tsx`            | 侧栏换 `Sidebar` + 挂 StyleBar/NoteModal              | Modify |

---

## Task 1: annotations 表 + 迁移

**Files:** Modify `src/main/db/schema.ts`；Create 迁移目录（`pnpm db:generate`）

- [ ] **Step 1: 加表定义** — `src/main/db/schema.ts`，在 `progress` 表之后加（复用文件顶部已有的 `pkUuid()`/`nowMs()` 工厂、`books` 表、`check`/`index`/`sql`）：

```ts
export const annotations = sqliteTable(
  "annotations",
  {
    id: pkUuid(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id),
    style: text("style").notNull(), // yellow|green|blue|pink|purple|underline
    note: text("note").notNull().default(""),
    selectedText: text("selected_text").notNull(),
    cfiRange: text("cfi_range").notNull(),
    createdAt: nowMs(),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    check(
      "annotations_style_check",
      sql`${t.style} in ('yellow','green','blue','pink','purple','underline')`,
    ),
    index("annotations_book_id_idx").on(t.bookId),
  ],
);
```

- [ ] **Step 2: 生成迁移**

Run: `pnpm db:generate`
Expected: `src/main/db/migrations/` 下新增一个 `<timestamp>_<name>/`（含 `migration.sql` 建 `annotations` 表 + CHECK + index + `snapshot.json`）。**勿手编**。

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/main/db/schema.ts src/main/db/migrations
git commit -m "$(printf 'feat(annotations): add annotations table + migration\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 2: shared/annotations.ts（Zod + DTO）+ IPC 通道常量

**Files:** Create `src/shared/annotations.ts`；Modify `src/shared/ipc.ts`

- [ ] **Step 1: 写 `src/shared/annotations.ts`**（对齐 `src/shared/chat.ts`：Zod schema + `z.infer`，DTO 用 interface）：

```ts
import { z } from "zod";

export const annotationStyle = z.enum(["yellow", "green", "blue", "pink", "purple", "underline"]);
export type AnnotationStyle = z.infer<typeof annotationStyle>;

export interface AnnotationDto {
  id: string;
  bookId: string;
  style: AnnotationStyle;
  note: string;
  selectedText: string;
  cfiRange: string;
  createdAt: number;
  updatedAt: number;
}

export const createAnnotationInput = z.object({
  bookId: z.string().min(1),
  style: annotationStyle,
  note: z.string(),
  selectedText: z.string().min(1),
  cfiRange: z.string().min(1),
});
export type CreateAnnotationInput = z.infer<typeof createAnnotationInput>;

export const updateAnnotationInput = z.object({
  id: z.string().min(1),
  patch: z.object({ style: annotationStyle.optional(), note: z.string().optional() }),
});
export type UpdateAnnotationInput = z.infer<typeof updateAnnotationInput>;

export const annotationIdInput = z.object({ id: z.string().min(1) });
export type AnnotationIdInput = z.infer<typeof annotationIdInput>;
```

- [ ] **Step 2: 加 IPC 通道常量** — `src/shared/ipc.ts` 的 `IPC` 对象里，在 `aiChunk` 行之后加：

```ts
  annotationsListByBook: "annotations:list-by-book",
  annotationsCreate: "annotations:create",
  annotationsUpdate: "annotations:update",
  annotationsDelete: "annotations:delete",
```

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/shared/annotations.ts src/shared/ipc.ts
git commit -m "$(printf 'feat(annotations): add shared Zod schemas, DTO and IPC channels\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 3: repository（annotations.ts）+ headless 测（TDD）

**Files:** Create `src/main/library/annotations.ts`、`src/main/library/annotations.test.ts`

- [ ] **Step 1: 写失败测试** — `src/main/library/annotations.test.ts`（对齐 `conversations.test.ts` 的 `createDb(":memory:") + runMigrations` 模式）：

```ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { annotations, books } from "@main/db/schema";
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotationsByBook,
  updateAnnotation,
} from "@main/library/annotations";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  db.insert(books).values({ id: "book-1", path: "/tmp/a.epub" }).run();
  return db;
}

const base = {
  bookId: "book-1",
  style: "yellow" as const,
  note: "",
  selectedText: "hello world",
  cfiRange: "epubcfi(/6/4!/4/2,/1:0,/1:5)",
};

describe("annotations repository", () => {
  it("creates and lists by book", () => {
    const db = freshDb();
    const a = createAnnotation(db, base);
    expect(a.id).toBeTruthy();
    expect(a.style).toBe("yellow");
    expect(a.note).toBe("");
    const list = listAnnotationsByBook(db, "book-1");
    expect(list.map((x) => x.id)).toEqual([a.id]);
  });

  it("updates style and note", () => {
    const db = freshDb();
    const a = createAnnotation(db, base);
    const u = updateAnnotation(db, { id: a.id, patch: { style: "green", note: "my note" } });
    expect(u.style).toBe("green");
    expect(u.note).toBe("my note");
    expect(u.updatedAt).toBeGreaterThanOrEqual(a.createdAt);
  });

  it("deletes", () => {
    const db = freshDb();
    const a = createAnnotation(db, base);
    deleteAnnotation(db, a.id);
    expect(listAnnotationsByBook(db, "book-1")).toEqual([]);
  });

  it("throws for unknown book on create", () => {
    const db = freshDb();
    expect(() => createAnnotation(db, { ...base, bookId: "no-such" })).toThrow(/book .* not found/);
  });

  it("rejects an invalid style at the DB CHECK", () => {
    const db = freshDb();
    expect(() =>
      db
        .insert(annotations)
        .values({ bookId: "book-1", style: "rainbow", selectedText: "x", cfiRange: "epubcfi(/1)" })
        .run(),
    ).toThrow();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/library/annotations.test.ts`
Expected: FAIL（`@main/library/annotations` 模块不存在）。

- [ ] **Step 3: 实现 `src/main/library/annotations.ts`**（对齐 `conversations.ts` 的 `toDto` + drizzle 写法）：

```ts
import { desc, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { annotations, books } from "@main/db/schema";
import type {
  AnnotationDto,
  AnnotationStyle,
  CreateAnnotationInput,
  UpdateAnnotationInput,
} from "@shared/annotations";

type AnnotationRow = typeof annotations.$inferSelect;

function toDto(row: AnnotationRow): AnnotationDto {
  return {
    id: row.id,
    bookId: row.bookId,
    style: row.style as AnnotationStyle,
    note: row.note,
    selectedText: row.selectedText,
    cfiRange: row.cfiRange,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 列出某书的全部标注（最近创建在前；阅读序排序在渲染层做）。 */
export function listAnnotationsByBook(db: DB, bookId: string): AnnotationDto[] {
  return db
    .select()
    .from(annotations)
    .where(eq(annotations.bookId, bookId))
    .orderBy(desc(annotations.createdAt))
    .all()
    .map(toDto);
}

/** 建标注；缺书抛可读错误。 */
export function createAnnotation(db: DB, input: CreateAnnotationInput): AnnotationDto {
  const book = db.select({ id: books.id }).from(books).where(eq(books.id, input.bookId)).get();
  if (!book) throw new Error(`createAnnotation: book ${input.bookId} not found`);
  const row = db
    .insert(annotations)
    .values({
      bookId: input.bookId,
      style: input.style,
      note: input.note,
      selectedText: input.selectedText,
      cfiRange: input.cfiRange,
    })
    .returning()
    .get();
  return toDto(row);
}

/** 改样式/笔记；缺标注抛错。 */
export function updateAnnotation(db: DB, input: UpdateAnnotationInput): AnnotationDto {
  const row = db
    .update(annotations)
    .set({ ...input.patch, updatedAt: Date.now() })
    .where(eq(annotations.id, input.id))
    .returning()
    .get();
  if (!row) throw new Error(`updateAnnotation: annotation ${input.id} not found`);
  return toDto(row);
}

/** 删标注（幂等）。 */
export function deleteAnnotation(db: DB, id: string): void {
  db.delete(annotations).where(eq(annotations.id, id)).run();
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/library/annotations.test.ts`
Expected: PASS（5 用例）。

- [ ] **Step 5: Commit**

```bash
git add src/main/library/annotations.ts src/main/library/annotations.test.ts
git commit -m "$(printf 'feat(annotations): repository (create/list/update/delete) with headless tests\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 4: IPC handlers + 注册 + preload

**Files:** Create `src/main/ipc/annotations-handlers.ts`；Modify `src/main.ts`、`src/preload.ts`

- [ ] **Step 1: 写 `src/main/ipc/annotations-handlers.ts`**（对齐 `chat-handlers.ts`）：

```ts
import { IPC } from "@shared/ipc";
import { bookIdInput } from "@shared/library";
import {
  annotationIdInput,
  createAnnotationInput,
  updateAnnotationInput,
  type AnnotationDto,
  type CreateAnnotationInput,
  type UpdateAnnotationInput,
} from "@shared/annotations";
import { getDb } from "@main/db/instance";
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotationsByBook,
  updateAnnotation,
} from "@main/library/annotations";
import { handle } from "@main/ipc/registry";

export function registerAnnotationHandlers(): void {
  handle<{ bookId: string }, AnnotationDto[]>(IPC.annotationsListByBook, bookIdInput, (input) =>
    listAnnotationsByBook(getDb(), input.bookId),
  );
  handle<CreateAnnotationInput, AnnotationDto>(
    IPC.annotationsCreate,
    createAnnotationInput,
    (input) => createAnnotation(getDb(), input),
  );
  handle<UpdateAnnotationInput, AnnotationDto>(
    IPC.annotationsUpdate,
    updateAnnotationInput,
    (input) => updateAnnotation(getDb(), input),
  );
  handle<{ id: string }, void>(IPC.annotationsDelete, annotationIdInput, (input) =>
    deleteAnnotation(getDb(), input.id),
  );
}
```

- [ ] **Step 2: 注册到 main.ts** — `src/main.ts` 的 `app.on("ready", ...)` 内，`registerChatHandlers();` 之后加 `registerAnnotationHandlers();`，并在顶部 import 区加 `import { registerAnnotationHandlers } from "@main/ipc/annotations-handlers";`（与其它 `register*Handlers` import 并列）。

- [ ] **Step 3: 暴露 preload** — `src/preload.ts`：① import 区加 `import type { AnnotationDto, CreateAnnotationInput, UpdateAnnotationInput } from "@shared/annotations";`；② 在 `api` 对象里（与 `content`/`progress` 并列）加：

```ts
  annotations: {
    listByBook: (input: BookIdInput): Promise<AnnotationDto[]> =>
      ipcRenderer.invoke(IPC.annotationsListByBook, input),
    create: (input: CreateAnnotationInput): Promise<AnnotationDto> =>
      ipcRenderer.invoke(IPC.annotationsCreate, input),
    update: (input: UpdateAnnotationInput): Promise<AnnotationDto> =>
      ipcRenderer.invoke(IPC.annotationsUpdate, input),
    delete: (input: { id: string }): Promise<void> =>
      ipcRenderer.invoke(IPC.annotationsDelete, input),
  },
```

- [ ] **Step 4: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test 2>&1 | tail -4`
Expected: typecheck 无错误；全量测试通过（含 Task 3 新增 5 用例）。

- [ ] **Step 5: Commit**

```bash
git add src/main/ipc/annotations-handlers.ts src/main.ts src/preload.ts
git commit -m "$(printf 'feat(annotations): IPC handlers, registration and preload exposure\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 5: epub-book —— `ignoreClass` + `rangeFromCfi`

**Files:** Modify `src/renderer/reader/epub-book.ts`

> 插入的 `<mark class="anno">` 改变 DOM，CFI 计算须传 `ignoreClass:"anno"` 防污染；并加 CFI→Range 反查（toRange）供高亮渲染。

- [ ] **Step 1: 核对 epubjs ignoreClass / toRange / compare 签名**

查看 `node_modules/epubjs/types/{section,epubcfi}.d.ts`，确认：

- `section.cfiFromRange(range, ignoreClass?)` / `section.cfiFromElement(el, ignoreClass?)` 是否收 `ignoreClass`；
- `EpubCFI.prototype.toRange(doc?, ignoreClass?)`、`EpubCFI.prototype.compare(a, b)`、`EpubCFI.prototype.spinePos`。
  记录实际签名，据此调整下面代码（若 `section.cfiFromRange` 不收 ignoreClass，改用 `new EpubCFI(range, s.cfiBase, ANNO_IGNORE_CLASS).toString()`）。

- [ ] **Step 2: 改 `epub-book.ts`**：在文件顶部（`firstBlock` 之前）加常量，并给 `EpubBook` 接口加 `rangeFromCfi`：

```ts
/** 高亮 mark 的 class；CFI 计算 / toRange 时作为 ignoreClass 传入，防止 mark 污染 CFI 路径。 */
export const ANNO_IGNORE_CLASS = "anno";
```

接口里（在 `cfiFromRange` 之后）加：

```ts
/** CFI 区间串 → 给定 section 文档内的 DOM Range（高亮渲染）；失败返回 null。 */
rangeFromCfi: (cfi: string, doc: Document) => Range | null;
```

实现里：把 `cfiAtIndex` 的 `s.cfiFromElement(firstBlock(s.document))` 改为带 ignoreClass、`cfiFromRange` 的 `s.cfiFromRange(range)` 改为带 ignoreClass，并新增 `rangeFromCfi`：

```ts
    cfiAtIndex: (index) => {
      const s = sectionAt(index);
      if (!s || !s.document) return null;
      try {
        return s.cfiFromElement(firstBlock(s.document), ANNO_IGNORE_CLASS);
      } catch {
        return null;
      }
    },

    cfiFromRange: (index, range) => {
      const s = sectionAt(index);
      if (!s) return null;
      try {
        return s.cfiFromRange(range, ANNO_IGNORE_CLASS);
      } catch {
        return null;
      }
    },

    rangeFromCfi: (cfi, doc) => {
      try {
        return new EpubCFI(cfi).toRange(doc, ANNO_IGNORE_CLASS);
      } catch {
        return null;
      }
    },
```

> `EpubCFI` 已在文件顶部 import。若 Step 1 发现 `cfiFromElement`/`cfiFromRange` 不收 ignoreClass 第二参，则保持原调用、仅在 `rangeFromCfi` 与「新选区算 CFI」处用 `new EpubCFI(range, s.cfiBase, ANNO_IGNORE_CLASS)`；在报告里说明实际签名。

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/reader/epub-book.ts
git commit -m "$(printf 'feat(reader): epub-book ignoreClass on CFI + rangeFromCfi(toRange)\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 6: virtual-docs 包 —— decorate / onHighlightClick / redecorate

**Files:** Modify `packages/virtual-docs/src/SectionFrame.tsx`、`packages/virtual-docs/src/VirtualDocs.tsx`

> 保持包对 epub 无知：`decorate(index, doc)` 让 app 在已加载的 iframe 文档上做装饰（包不碰 CFI）；包自身侦听 `[data-anno-id]` 点击并回调视口坐标；`redecorate()` 让所有在挂 section 重跑 decorate。

- [ ] **Step 1: 改 `SectionFrame.tsx`** —— 加 props 与装饰/点击逻辑。把 `Props` 与组件签名改为：

```tsx
interface Props {
  index: number;
  html: string;
  styleCss?: string;
  onSelect?: (e: SectionSelectEvent) => void;
  onSelectionCleared?: () => void;
  /** iframe 内容加载后（及 decorateNonce 变化时）回调，供消费方在文档上贴装饰（如高亮 mark）。 */
  decorate?: (index: number, doc: Document) => void;
  /** 点击带 data-anno-id 的装饰元素时回调（rect 为视口坐标）。 */
  onHighlightClick?: (annoId: string, rect: ViewportRect) => void;
  /** 变化即对已加载文档重跑 decorate（标注增删改后由 VirtualDocs 递增）。 */
  decorateNonce?: number;
}

export function SectionFrame({
  index,
  html,
  styleCss,
  onSelect,
  onSelectionCleared,
  decorate,
  onHighlightClick,
  decorateNonce,
}: Props) {
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const cbRef = useRef({ onSelect, onSelectionCleared, decorate, onHighlightClick });
  cbRef.current = { onSelect, onSelectionCleared, decorate, onHighlightClick };
  const docRef = useRef<Document | null>(null);
```

在 `onLoad` 里，`doc` 赋值并测高之后，追加装饰 + 高亮点击委托（放在 `doc.addEventListener("selectionchange", ...)` 之后）：

```tsx
docRef.current = doc;
cbRef.current.decorate?.(index, doc);
doc.addEventListener("click", onAnnoClick);
```

并在 `onMouseUp`/`onSelChange` 旁定义 `onAnnoClick`，在 `detach()` 里解绑 + 清 docRef：

```tsx
const onAnnoClick = (e: MouseEvent) => {
  if (!doc) return;
  const el = (e.target as Element | null)?.closest?.("[data-anno-id]") as HTMLElement | null;
  if (!el) return;
  const id = el.getAttribute("data-anno-id");
  if (!id) return;
  const r = el.getBoundingClientRect();
  const fr = iframe.getBoundingClientRect();
  cbRef.current.onHighlightClick?.(id, toViewportRect(r, fr));
};
```

```tsx
const detach = () => {
  ro?.disconnect();
  ro = undefined;
  doc?.removeEventListener("mouseup", onMouseUp);
  doc?.removeEventListener("selectionchange", onSelChange);
  doc?.removeEventListener("click", onAnnoClick);
  doc = null;
  docRef.current = null;
};
```

加一个 effect：`decorateNonce` 变化时对已加载文档重跑 decorate（放在 `srcDoc` useMemo 之前）：

```tsx
useEffect(() => {
  if (docRef.current) cbRef.current.decorate?.(index, docRef.current);
}, [decorateNonce, index]);
```

- [ ] **Step 2: 改 `VirtualDocs.tsx`** —— 透传 props + `redecorate()`。给 `VirtualDocsHandle` 加方法、`VirtualDocsProps` 加 props、`useImperativeHandle` 加 `redecorate`、`itemContent` 透传：

```tsx
export interface VirtualDocsHandle {
  scrollToIndex: (index: number) => void;
  /** 对所有在挂 section 重跑 decorate（标注增删改后调用）。 */
  redecorate: () => void;
}
```

`VirtualDocsProps` 加（在 `onSelectionCleared?` 之后）：

```tsx
  decorate?: (index: number, doc: Document) => void;
  onHighlightClick?: (annoId: string, rect: ViewportRect) => void;
```

> `ViewportRect` 已从 `./geometry` 经 `SectionFrame` 导出链可达；在 `VirtualDocs.tsx` 顶部加 `import type { ViewportRect } from "./geometry";`（若未导入）。

组件内加 `decorateNonce` state + 在 `useImperativeHandle` 暴露 `redecorate`：

```tsx
const [decorateNonce, setDecorateNonce] = useState(0);
useImperativeHandle(
  ref,
  () => ({
    scrollToIndex: (index: number) => vRef.current?.scrollToIndex({ index, align: "start" }),
    redecorate: () => setDecorateNonce((n) => n + 1),
  }),
  [],
);
```

`itemContent`（透传新 props 给 `LazySection`→`SectionFrame`；把 `decorate`/`onHighlightClick`/`decorateNonce` 加进 `useCallback` 依赖与 `LazySection` props）：

```tsx
const itemContent = useCallback(
  (index: number) => (
    <LazySection
      index={index}
      loadSection={loadSection}
      styleCss={styleCss}
      onSelect={onSelect}
      onSelectionCleared={onSelectionCleared}
      decorate={decorate}
      onHighlightClick={onHighlightClick}
      decorateNonce={decorateNonce}
    />
  ),
  [loadSection, styleCss, onSelect, onSelectionCleared, decorate, onHighlightClick, decorateNonce],
);
```

并给 `LazySection` 的 props 与透传到 `<SectionFrame>` 加上 `decorate`/`onHighlightClick`/`decorateNonce`（照 `onSelect` 的传法补三个）。

- [ ] **Step 3: typecheck（含 ui-prototype）**

Run: `pnpm typecheck && pnpm --dir packages/ui-prototype typecheck`
Expected: 无错误（新 props 全可选，旧用法不破）。

> 若 `pnpm --dir packages/ui-prototype typecheck` 脚本名不同，用 `packages/ui-prototype` 内的 `typecheck` 脚本（README/坑：原型独立 lock）。仅需确认包改动不破坏原型对 VirtualDocs 的现有用法。

- [ ] **Step 4: Commit**

```bash
git add packages/virtual-docs/src/SectionFrame.tsx packages/virtual-docs/src/VirtualDocs.tsx
git commit -m "$(printf 'feat(virtual-docs): add decorate/onHighlightClick/redecorate hooks\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 7: 渲染层基建 —— highlight.ts + query key + store UI 态

**Files:** Create `src/renderer/reader/highlight.ts`；Modify `src/renderer/query/keys.ts`、`src/renderer/store/reader-store.ts`

- [ ] **Step 1: 写 `src/renderer/reader/highlight.ts`**：

```ts
import type { AnnotationStyle } from "@shared/annotations";

/** 5 个填充色键（下划线单独处理，不在色点里）。 */
export const FILL_COLORS = ["yellow", "green", "blue", "pink", "purple"] as const;
export type FillColor = (typeof FILL_COLORS)[number];

/** 主文档内（Tailwind 生效）：工具栏色点 swatch + 侧栏列表色条 stripe。 */
export const FILL_SWATCH: Record<FillColor, string> = {
  yellow: "bg-yellow-300",
  green: "bg-green-300",
  blue: "bg-sky-300",
  pink: "bg-pink-300",
  purple: "bg-purple-300",
};

export const STYLE_STRIPE: Record<AnnotationStyle, string> = {
  yellow: "bg-yellow-400",
  green: "bg-green-400",
  blue: "bg-sky-400",
  pink: "bg-pink-400",
  purple: "bg-purple-400",
  underline: "bg-foreground/40",
};

/**
 * 注入每个 section iframe 的高亮 CSS（iframe 是 sandboxed srcdoc，主应用 Tailwind 不生效，
 * 故用具体 CSS）。`.anno` 可点击；5 色背景填充；underline 走 text-decoration；
 * `.anno-noted` 叠虚线下划表示有笔记。
 */
export const ANNO_IFRAME_CSS = [
  "mark.anno { background: transparent; cursor: pointer; }",
  "mark.anno-yellow { background: rgba(254,240,138,0.7); }",
  "mark.anno-green { background: rgba(187,247,208,0.7); }",
  "mark.anno-blue { background: rgba(186,230,253,0.7); }",
  "mark.anno-pink { background: rgba(251,207,232,0.7); }",
  "mark.anno-purple { background: rgba(233,213,255,0.7); }",
  "mark.anno-underline { background: transparent; text-decoration: underline; text-decoration-color: rgba(120,120,120,0.9); text-decoration-thickness: 2px; }",
  "mark.anno-noted { text-decoration: underline dotted; text-underline-offset: 3px; }",
].join("\n");
```

- [ ] **Step 2: 加 query key** — `src/renderer/query/keys.ts` 的 `qk` 对象里（`progress` 行后）加：

```ts
  annotations: (bookId: string) => ["annotations", bookId] as const,
```

- [ ] **Step 3: 加 store UI 态** — `src/renderer/store/reader-store.ts`：在文件顶部 import 后加类型，并扩展 state/actions/initial/实现。

类型（加在 `interface ReaderState` 之前）：

```ts
export type AnnoTarget = { type: "create" } | { type: "edit"; annotationId: string };
export interface StyleBarState {
  rect: { x: number; y: number; width: number; height: number };
  target: AnnoTarget;
}
export interface NoteModalState {
  target: AnnoTarget;
}
```

`ReaderState` 加字段：

```ts
  styleBar: StyleBarState | null;
  noteModal: NoteModalState | null;
  scrollToCfi: { cfi: string; nonce: number } | null;
```

`ReaderActions` 加：

```ts
  openStyleBar: (s: StyleBarState) => void;
  closeStyleBar: () => void;
  openNoteModal: (s: NoteModalState) => void;
  closeNoteModal: () => void;
  requestScrollToCfi: (cfi: string) => void;
```

`READER_INITIAL` 加：

```ts
  styleBar: null,
  noteModal: null,
  scrollToCfi: null,
```

`create(...)` 实现里加：

```ts
  openStyleBar: (styleBar) => set({ styleBar }),
  closeStyleBar: () => set({ styleBar: null }),
  openNoteModal: (noteModal) => set({ noteModal }),
  closeNoteModal: () => set({ noteModal: null }),
  requestScrollToCfi: (cfi) =>
    set((s) => ({ scrollToCfi: { cfi, nonce: (s.scrollToCfi?.nonce ?? 0) + 1 } })),
```

- [ ] **Step 4: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/reader/highlight.ts src/renderer/query/keys.ts src/renderer/store/reader-store.ts
git commit -m "$(printf 'feat(reader): highlight style map, annotations query key, store UI state\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 8: EpubReader 接标注 —— query + decorate（CFI→mark）+ 点击 + 跳转

**Files:** Create `src/renderer/reader/apply-annotations.ts`；Modify `src/renderer/reader/EpubReader.tsx`

> 渲染管线 + 点击 + 列表跳转的接线。无 headless 测（DOM/iframe），靠 typecheck + 手测。

- [ ] **Step 1: 写 `src/renderer/reader/apply-annotations.ts`**（清旧 mark → 按 CFI toRange → 包文本节点）：

```ts
import type { AnnotationDto } from "@shared/annotations";
import type { EpubBook } from "./epub-book";

/** 移除文档内全部高亮 mark（用其文本内容替换 mark，再合并相邻文本节点）。 */
export function clearAnnoMarks(doc: Document): void {
  const marks = Array.from(doc.querySelectorAll("mark.anno"));
  for (const mark of marks) {
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
  }
}

/** 把一个 Range（可能跨多个文本节点）按文本节点逐段包成 <mark>。 */
function wrapRange(range: Range, doc: Document, className: string, annoId: string): void {
  const root = range.commonAncestorContainer;
  const walker = doc.createTreeWalker(
    root.nodeType === Node.ELEMENT_NODE
      ? root
      : (root.parentNode ?? doc.body ?? doc.documentElement),
    NodeFilter.SHOW_TEXT,
  );
  const textNodes: Text[] = [];
  let n = walker.nextNode();
  while (n) {
    const t = n as Text;
    if (range.intersectsNode(t) && (t.textContent ?? "").length > 0) textNodes.push(t);
    n = walker.nextNode();
  }
  for (const textNode of textNodes) {
    const start = textNode === range.startContainer ? range.startOffset : 0;
    const end =
      textNode === range.endContainer ? range.endOffset : (textNode.textContent ?? "").length;
    if (end <= start) continue;
    const sub = doc.createRange();
    sub.setStart(textNode, start);
    sub.setEnd(textNode, end);
    const mark = doc.createElement("mark");
    mark.className = className;
    mark.setAttribute("data-anno-id", annoId);
    try {
      sub.surroundContents(mark); // 单文本节点内的子 Range 可安全 surround
    } catch {
      /* 极端结构跳过该段（best-effort） */
    }
  }
}

/**
 * 把属于第 index 个 section 的标注渲染为高亮 mark。先清旧 mark（幂等），
 * 再按 `book.indexOfCfi(cfiRange)===index` 过滤、`book.rangeFromCfi` 取 Range 后包裹。
 * toRange 失败（CFI 失效）跳过该条（best-effort），它仍在侧栏列表（快照展示）。
 */
export function applyAnnotations(
  book: EpubBook,
  annotations: AnnotationDto[],
  index: number,
  doc: Document,
): void {
  clearAnnoMarks(doc);
  for (const a of annotations) {
    if (book.indexOfCfi(a.cfiRange) !== index) continue;
    const range = book.rangeFromCfi(a.cfiRange, doc);
    if (!range) continue;
    const noted = a.note.trim().length > 0 ? " anno-noted" : "";
    wrapRange(range, doc, `anno anno-${a.style}${noted}`, a.id);
  }
}
```

- [ ] **Step 2: 改 `EpubReader.tsx`** —— 接 annotations query、styleCss 附 `ANNO_IFRAME_CSS`、decorate/onHighlightClick、redecorate effect、跳转 effect。

加 import：

```tsx
import { useReaderStore } from "../store/reader-store";
import { applyAnnotations } from "./apply-annotations";
import { ANNO_IFRAME_CSS } from "./highlight";
import type { SectionSelectEvent } from "@marginalia/virtual-docs"; // 若已 import 忽略
```

组件内加 store 选择器 + annotations query（与现有 `bytes`/`progress` query 并列）：

```tsx
const openStyleBar = useReaderStore((s) => s.openStyleBar);
const scrollToCfi = useReaderStore((s) => s.scrollToCfi);

const annotations = useQuery({
  queryKey: qk.annotations(bookId),
  queryFn: () => window.api.annotations.listByBook({ bookId }),
  staleTime: Infinity,
});
```

加 decorate / onHighlightClick（与 `onSelect`/`onTopIndexChange` 并列；闭包引用 `book` + `annotations.data`，React Compiler 自动记忆）：

```tsx
const decorate = (index: number, doc: Document) => {
  if (book) applyAnnotations(book, annotations.data ?? [], index, doc);
};
const onHighlightClick = (
  annoId: string,
  rect: { x: number; y: number; width: number; height: number },
) => {
  openStyleBar({ rect, target: { type: "edit", annotationId: annoId } });
};
```

加两个 effect（标注变化 → 重渲染；列表点击 → 跳转）：

```tsx
// 标注数据变化（建/改/删后 invalidate）→ 对在挂 section 重贴高亮。
useEffect(() => {
  vRef.current?.redecorate();
}, [annotations.data]);

// 侧栏列表点击 → 滚到该标注所在 section（best-effort：稍后把 mark 滚入视口）。
useEffect(() => {
  if (!book || !scrollToCfi) return;
  const idx = book.indexOfCfi(scrollToCfi.cfi);
  if (idx >= 0) vRef.current?.scrollToIndex(idx);
}, [book, scrollToCfi]);
```

把 `<VirtualDocs>` 的 `styleCss` 改为附加高亮 CSS、并加 `decorate`/`onHighlightClick`：

```tsx
<VirtualDocs
  ref={vRef}
  count={book.count}
  loadSection={book.loadSection}
  styleCss={prefsToCss(prefs) + "\n" + ANNO_IFRAME_CSS}
  initialIndex={initialIndex}
  onTopIndexChange={onTopIndexChange}
  onSelect={onSelect}
  onSelectionCleared={onSelectionCleared}
  decorate={decorate}
  onHighlightClick={onHighlightClick}
/>
```

> `qk` 已在 EpubReader import。`book` 解析后 set 一次，`decorate` 闭包稳定足够；annotations.data 变化经 redecorate effect 重贴。

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/reader/apply-annotations.ts src/renderer/reader/EpubReader.tsx
git commit -m "$(printf 'feat(reader): render annotations as marks via decorate + wire click/jump\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

- [ ] **Step 5: 【手测检查点】**（需先有 Task 9/10 才能在 UI 建标注；本步先临时验证渲染管线）

可临时在 devtools 控制台用 `window.api.annotations.create({...})` 插一条（cfiRange 取一次真实选区的 `store.selection.cfiRange`）后刷新，确认正文出现高亮、点击高亮触发（此时 styleBar 组件尚未挂载，看 console / store 变化即可）。或直接跳到 Task 10 完成后整体验收。**正式手测在 Task 10/11/12 各检查点。**

---

## Task 9: SelectionToolbar 加「高亮标记 / 添加笔记」入口

**Files:** Modify `src/renderer/reader/SelectionToolbar.tsx`

- [ ] **Step 1: 改 `SelectionToolbar.tsx`** —— 在 AI 按钮前加两个入口，打开 styleBar/noteModal（针对当前选区）。完整替换组件为：

```tsx
import type { ReactNode } from "react";
import { BookOpen, FileText, Highlighter, Languages, Sparkles, StickyNote } from "lucide-react";
import { cn } from "@renderer/lib/utils";
import { useReaderStore } from "@renderer/store/reader-store";
import { useAiActions, type PresetId } from "@renderer/ai/use-ai-actions";

const PRESETS: { id: PresetId; label: string; icon: typeof BookOpen }[] = [
  { id: "explain", label: "解释", icon: BookOpen },
  { id: "translate", label: "翻译", icon: Languages },
  { id: "summarize", label: "概括", icon: FileText },
];

export function SelectionToolbar() {
  const selection = useReaderStore((s) => s.selection);
  const openStyleBar = useReaderStore((s) => s.openStyleBar);
  const openNoteModal = useReaderStore((s) => s.openNoteModal);
  const { startAiAction } = useAiActions();
  if (!selection || !selection.rect) return null;

  const { rect } = selection;
  const PAD = 220;
  const left = Math.min(Math.max(rect.x + rect.width / 2, PAD), window.innerWidth - PAD);
  const top = rect.y - 10;

  return (
    <div
      onMouseDown={(e) => e.preventDefault()}
      style={{ position: "fixed", left, top, transform: "translate(-50%, -100%)", zIndex: 50 }}
      className="flex w-max items-center gap-0.5 whitespace-nowrap rounded-xl border border-border bg-popover/95 p-1 shadow-lg backdrop-blur"
    >
      <ToolBtn
        onClick={() => openStyleBar({ rect, target: { type: "create" } })}
        icon={<Highlighter className="size-3.5" />}
        label="高亮标记"
      />
      <ToolBtn
        onClick={() => openNoteModal({ target: { type: "create" } })}
        icon={<StickyNote className="size-3.5" />}
        label="添加笔记"
      />
      <span className="mx-0.5 h-5 w-px bg-border" />
      <ToolBtn
        primary
        onClick={() => void startAiAction(null)}
        icon={<Sparkles className="size-3.5 text-primary" />}
        label="AI 问"
      />
      {PRESETS.map((p) => {
        const Icon = p.icon;
        return (
          <ToolBtn
            key={p.id}
            onClick={() => void startAiAction(p.id)}
            icon={<Icon className="size-3.5" />}
            label={p.label}
          />
        );
      })}
    </div>
  );
}

function ToolBtn({
  icon,
  label,
  onClick,
  primary,
}: {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  primary?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-medium hover:bg-muted",
        primary && "text-primary",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
```

> 打开 styleBar/noteModal 时**不清选区**（建标注时才清）——styleBar/noteModal 需要 `store.selection` 的 `cfiRange`/`selectedText`。打开样式工具栏后主工具栏仍在也无妨（styleBar 浮于其上、zIndex 更高）。

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/reader/SelectionToolbar.tsx
git commit -m "$(printf 'feat(reader): add highlight/note entries to selection toolbar\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

---

## Task 10: HighlightStyleBar（二级样式工具栏）+ 挂载

**Files:** Create `src/renderer/reader/HighlightStyleBar.tsx`；Modify `src/renderer/reader/ReaderView.tsx`

- [ ] **Step 1: 写 `src/renderer/reader/HighlightStyleBar.tsx`**：

```tsx
import { useEffect, useRef } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Trash2, Underline } from "lucide-react";
import type { AnnotationStyle } from "@shared/annotations";
import { cn } from "@renderer/lib/utils";
import { qk } from "@renderer/query/keys";
import { useReaderStore } from "@renderer/store/reader-store";
import { FILL_COLORS, FILL_SWATCH } from "./highlight";

/** 二级样式工具栏：5 色 + 下划线；create 来自选区，edit 来自点已有高亮（多 笔记/删除）。 */
export function HighlightStyleBar() {
  const styleBar = useReaderStore((s) => s.styleBar);
  const closeStyleBar = useReaderStore((s) => s.closeStyleBar);
  const openNoteModal = useReaderStore((s) => s.openNoteModal);
  const selection = useReaderStore((s) => s.selection);
  const setSelection = useReaderStore((s) => s.setSelection);
  const bookId = useReaderStore((s) => s.currentBookId);
  const qc = useQueryClient();
  const ref = useRef<HTMLDivElement | null>(null);

  const annos = useQuery({
    queryKey: qk.annotations(bookId ?? ""),
    queryFn: () => window.api.annotations.listByBook({ bookId: bookId! }),
    enabled: bookId != null,
  });

  const invalidate = () => qc.invalidateQueries({ queryKey: qk.annotations(bookId ?? "") });
  const createM = useMutation({
    mutationFn: window.api.annotations.create,
    onSuccess: invalidate,
  });
  const updateM = useMutation({
    mutationFn: window.api.annotations.update,
    onSuccess: invalidate,
  });
  const deleteM = useMutation({
    mutationFn: window.api.annotations.delete,
    onSuccess: invalidate,
  });

  useEffect(() => {
    if (!styleBar) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) closeStyleBar();
    };
    document.addEventListener("mousedown", onDown);
    return () => document.removeEventListener("mousedown", onDown);
  }, [styleBar, closeStyleBar]);

  if (!styleBar || bookId == null) return null;
  const editing = styleBar.target.type === "edit" ? styleBar.target.annotationId : null;
  const current = editing ? annos.data?.find((a) => a.id === editing) : undefined;

  const pickStyle = (style: AnnotationStyle) => {
    if (styleBar.target.type === "create") {
      if (!selection?.cfiRange) return;
      createM.mutate({
        bookId,
        style,
        note: "",
        selectedText: selection.selectionText,
        cfiRange: selection.cfiRange,
      });
      setSelection(null);
    } else {
      updateM.mutate({ id: styleBar.target.annotationId, patch: { style } });
    }
    closeStyleBar();
  };

  const { rect } = styleBar;
  const left = Math.min(Math.max(rect.x + rect.width / 2, 160), window.innerWidth - 160);
  const top = rect.y - 8;

  return (
    <div
      ref={ref}
      onMouseDown={(e) => e.preventDefault()}
      style={{ position: "fixed", left, top, transform: "translate(-50%, -100%)", zIndex: 55 }}
      className="flex w-max items-center gap-1.5 rounded-xl border border-border bg-popover p-1.5 shadow-xl"
    >
      {FILL_COLORS.map((c) => (
        <button
          key={c}
          type="button"
          aria-label={`高亮 ${c}`}
          onClick={() => pickStyle(c)}
          className={cn(
            "size-5 rounded-full ring-offset-1 ring-offset-popover transition",
            FILL_SWATCH[c],
            current?.style === c ? "ring-2 ring-foreground/60" : "hover:scale-110",
          )}
        />
      ))}
      <button
        type="button"
        aria-label="下划线"
        onClick={() => pickStyle("underline")}
        className={cn(
          "grid size-6 place-items-center rounded-md hover:bg-muted",
          current?.style === "underline" && "bg-muted ring-1 ring-foreground/40",
        )}
      >
        <Underline className="size-4" />
      </button>
      {editing && (
        <>
          <span className="mx-0.5 h-5 w-px bg-border" />
          <button
            type="button"
            aria-label="笔记"
            onClick={() => {
              openNoteModal({ target: { type: "edit", annotationId: editing } });
              closeStyleBar();
            }}
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-muted"
          >
            <StickyNoteIcon />
          </button>
          <button
            type="button"
            aria-label="删除"
            onClick={() => {
              deleteM.mutate({ id: editing });
              closeStyleBar();
            }}
            className="grid size-6 place-items-center rounded-md text-muted-foreground hover:bg-destructive/10 hover:text-destructive"
          >
            <Trash2 className="size-4" />
          </button>
        </>
      )}
    </div>
  );
}

function StickyNoteIcon() {
  return <span className="text-xs">✎</span>;
}
```

> mutation 的 `onSuccess: invalidate` 会让 `qk.annotations` 重取 → EpubReader 的 redecorate effect 重贴高亮、侧栏列表刷新。`mutationFn` 直接用 `window.api.annotations.*`（其签名即 `(input) => Promise<...>`）。

- [ ] **Step 2: 挂载到 ReaderView** — `src/renderer/reader/ReaderView.tsx`：import `HighlightStyleBar`，在 `<SelectionToolbar />` 之后加 `<HighlightStyleBar />`。

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/reader/HighlightStyleBar.tsx src/renderer/reader/ReaderView.tsx
git commit -m "$(printf 'feat(reader): highlight style bar (create/restyle/delete) + mount\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

- [ ] **Step 5: 【手测检查点】** `pnpm start` + 真实 ePub：划词 → 主工具栏「高亮标记」→ 样式工具栏出 5 色 + 下划线 → 点一个 → 正文出现高亮（5 色背景 / 下划线）、选区清除。点已有高亮 → 样式工具栏（含删除）→ 换样式即变、删除即消。重开书高亮恢复。建高亮后在别处再划词，确认 CFI/进度不乱（ignoreClass 生效）。

---

## Task 11: NoteModal（笔记 modal）+ 挂载

**Files:** Create `src/renderer/reader/NoteModal.tsx`；Modify `src/renderer/reader/ReaderView.tsx`

- [ ] **Step 1: 写 `src/renderer/reader/NoteModal.tsx`**：

```tsx
import { useEffect, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { qk } from "@renderer/query/keys";
import { useReaderStore } from "@renderer/store/reader-store";

/** 居中笔记 modal：create 来自选区（默认 yellow），edit 来自已有标注。 */
export function NoteModal() {
  const noteModal = useReaderStore((s) => s.noteModal);
  const closeNoteModal = useReaderStore((s) => s.closeNoteModal);
  const selection = useReaderStore((s) => s.selection);
  const setSelection = useReaderStore((s) => s.setSelection);
  const bookId = useReaderStore((s) => s.currentBookId);
  const qc = useQueryClient();
  const taRef = useRef<HTMLTextAreaElement | null>(null);
  const [text, setText] = useState("");

  const annos = useQuery({
    queryKey: qk.annotations(bookId ?? ""),
    queryFn: () => window.api.annotations.listByBook({ bookId: bookId! }),
    enabled: bookId != null,
  });

  const editing = noteModal?.target.type === "edit" ? noteModal.target.annotationId : null;
  const current = editing ? annos.data?.find((a) => a.id === editing) : undefined;

  // 打开时初始化文本（edit 取现笔记，create 空）+ 聚焦。
  useEffect(() => {
    if (!noteModal) return;
    setText(editing ? (current?.note ?? "") : "");
    taRef.current?.focus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteModal, editing]);

  const invalidate = () => qc.invalidateQueries({ queryKey: qk.annotations(bookId ?? "") });
  const createM = useMutation({ mutationFn: window.api.annotations.create, onSuccess: invalidate });
  const updateM = useMutation({ mutationFn: window.api.annotations.update, onSuccess: invalidate });

  if (!noteModal || bookId == null) return null;

  const save = () => {
    if (noteModal.target.type === "create") {
      if (!selection?.cfiRange) return;
      createM.mutate({
        bookId,
        style: "yellow",
        note: text,
        selectedText: selection.selectionText,
        cfiRange: selection.cfiRange,
      });
      setSelection(null);
    } else {
      updateM.mutate({ id: noteModal.target.annotationId, patch: { note: text } });
    }
    closeNoteModal();
  };

  return (
    <div
      onMouseDown={closeNoteModal}
      style={{ position: "fixed", inset: 0, zIndex: 70 }}
      className="grid place-items-center bg-black/30"
    >
      <div
        onMouseDown={(e) => e.stopPropagation()}
        className="w-96 max-w-[90vw] rounded-xl border border-border bg-popover p-4 font-sans shadow-2xl"
      >
        <h2 className="mb-2 text-sm font-medium">{editing ? "编辑笔记" : "添加笔记"}</h2>
        <textarea
          ref={taRef}
          value={text}
          onChange={(e) => setText(e.target.value)}
          placeholder="写点想法…"
          rows={5}
          className="no-scrollbar w-full resize-none rounded-md border border-border bg-background px-2.5 py-2 text-sm outline-none placeholder:text-muted-foreground focus:ring-1 focus:ring-ring"
        />
        <div className="mt-3 flex justify-end gap-2">
          <button
            type="button"
            onClick={closeNoteModal}
            className="rounded-md px-3 py-1.5 text-sm text-muted-foreground hover:bg-muted"
          >
            取消
          </button>
          <button
            type="button"
            onClick={save}
            className="rounded-md bg-primary px-3 py-1.5 text-sm font-medium text-primary-foreground hover:bg-primary/90"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: 挂载到 ReaderView** — `src/renderer/reader/ReaderView.tsx`：import `NoteModal`，在 `<HighlightStyleBar />` 之后加 `<NoteModal />`。

- [ ] **Step 3: typecheck**

Run: `pnpm typecheck`
Expected: 无错误。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/reader/NoteModal.tsx src/renderer/reader/ReaderView.tsx
git commit -m "$(printf 'feat(reader): note modal (add/edit) + mount\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

- [ ] **Step 5: 【手测检查点】** `pnpm start`：划词 → 「添加笔记」→ modal → 写笔记保存 → 正文出现高亮（默认黄）带 ✎ 虚线、侧栏列表显示笔记。点已有高亮 → 样式工具栏「✎ 笔记」→ modal 改笔记保存 → 生效。取消/点遮罩关闭不改。

---

## Task 12: 侧栏「标注」列表 + 目录/标注 页签

**Files:** Create `src/renderer/reader/AnnotationsList.tsx`、`src/renderer/reader/Sidebar.tsx`；Modify `src/renderer/reader/ReaderView.tsx`

- [ ] **Step 1: 核对 epubjs `EpubCFI` 排序 API**

查看 `node_modules/epubjs/types/epubcfi.d.ts`，确认 `EpubCFI.prototype.compare(cfiOne, cfiTwo)` 与 `EpubCFI.prototype.spinePos`。`compare` 在则按它排序；否则退到按 `spinePos` 升序、`createdAt` 兜底（在报告里说明）。

- [ ] **Step 2: 写 `src/renderer/reader/AnnotationsList.tsx`**（排序用 `EpubCFI.compare`、分组用 `spinePos`↔chapter `orderIndex`、点击发 `requestScrollToCfi`）：

```tsx
import { useQuery } from "@tanstack/react-query";
import { EpubCFI } from "epubjs";
import { Trash2 } from "lucide-react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import type { AnnotationDto } from "@shared/annotations";
import type { ChapterRefDto } from "@shared/library";
import { cn } from "@renderer/lib/utils";
import { qk } from "@renderer/query/keys";
import { useReaderStore } from "@renderer/store/reader-store";
import { STYLE_STRIPE } from "./highlight";

const cfiCompare = new EpubCFI();
function spineOf(cfi: string): number {
  try {
    return new EpubCFI(cfi).spinePos ?? -1;
  } catch {
    return -1;
  }
}

export function AnnotationsList({ bookId }: { bookId: string }) {
  const requestScrollToCfi = useReaderStore((s) => s.requestScrollToCfi);
  const qc = useQueryClient();
  const annos = useQuery({
    queryKey: qk.annotations(bookId),
    queryFn: () => window.api.annotations.listByBook({ bookId }),
  });
  const chapters = useQuery({
    queryKey: qk.chapters(bookId),
    queryFn: () => window.api.content.chapters({ bookId }),
  });
  const deleteM = useMutation({
    mutationFn: window.api.annotations.delete,
    onSuccess: () => qc.invalidateQueries({ queryKey: qk.annotations(bookId) }),
  });

  if (annos.isPending) return <p className="p-3 text-sm text-muted-foreground">加载标注…</p>;
  const list = annos.data ?? [];
  if (list.length === 0)
    return <p className="p-4 text-center text-xs text-muted-foreground">还没有标注。划词试试～</p>;

  // 阅读序排序（compare 不可用时回退 spinePos）。
  const sorted = [...list].sort((a, b) => {
    try {
      return cfiCompare.compare(a.cfiRange, b.cfiRange);
    } catch {
      return spineOf(a.cfiRange) - spineOf(b.cfiRange);
    }
  });
  const chapterTitle = (cfi: string): string | null => {
    const sp = spineOf(cfi);
    const ch = (chapters.data ?? []).find((c: ChapterRefDto) => c.orderIndex === sp);
    return ch?.title ?? null;
  };

  return (
    <div className="space-y-1.5 overflow-y-auto p-2">
      {sorted.map((a) => (
        <AnnoItem
          key={a.id}
          a={a}
          chapter={chapterTitle(a.cfiRange)}
          onGoto={() => requestScrollToCfi(a.cfiRange)}
          onDelete={() => deleteM.mutate({ id: a.id })}
        />
      ))}
    </div>
  );
}

function AnnoItem({
  a,
  chapter,
  onGoto,
  onDelete,
}: {
  a: AnnotationDto;
  chapter: string | null;
  onGoto: () => void;
  onDelete: () => void;
}) {
  return (
    <div className="group flex gap-2 rounded-lg border border-border bg-background/60 p-2">
      <span className={cn("w-1 shrink-0 self-stretch rounded-full", STYLE_STRIPE[a.style])} />
      <button type="button" onClick={onGoto} className="min-w-0 flex-1 text-left">
        <div className="line-clamp-2 text-xs leading-relaxed text-foreground">{a.selectedText}</div>
        {a.note && (
          <div className="mt-1 line-clamp-2 text-[11px] text-muted-foreground">✎ {a.note}</div>
        )}
        {chapter && <div className="mt-1 text-[10px] text-muted-foreground/70">{chapter}</div>}
      </button>
      <button
        type="button"
        aria-label="删除"
        onClick={onDelete}
        className="grid size-6 shrink-0 self-start place-items-center rounded text-muted-foreground opacity-0 transition-opacity hover:bg-destructive/10 hover:text-destructive group-hover:opacity-100"
      >
        <Trash2 className="size-3.5" />
      </button>
    </div>
  );
}
```

> 分组用「chapter.orderIndex === spinePos」假定 chapters 与 spine 同序（RA1-min 章节由 spine 派生）；匹配不到则不显示章名（可接受）。本任务先做**扁平阅读序列表 + 章名标签**，按章「分组标题」可作后续小改。

- [ ] **Step 3: 写 `src/renderer/reader/Sidebar.tsx`**（目录/标注 页签容器）：

```tsx
import { useState } from "react";
import { List, Highlighter } from "lucide-react";
import { cn } from "@renderer/lib/utils";
import { ChapterList } from "./ChapterList";
import { AnnotationsList } from "./AnnotationsList";

export function Sidebar({ bookId }: { bookId: string }) {
  const [tab, setTab] = useState<"toc" | "notes">("toc");
  return (
    <div className="flex h-full flex-col">
      <div className="flex shrink-0 gap-1 border-b border-border p-1.5">
        <TabBtn
          active={tab === "toc"}
          onClick={() => setTab("toc")}
          icon={<List className="size-4" />}
          label="目录"
        />
        <TabBtn
          active={tab === "notes"}
          onClick={() => setTab("notes")}
          icon={<Highlighter className="size-4" />}
          label="标注"
        />
      </div>
      <div className="min-h-0 flex-1">
        {tab === "toc" ? <ChapterList bookId={bookId} /> : <AnnotationsList bookId={bookId} />}
      </div>
    </div>
  );
}

function TabBtn({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: React.ReactNode;
  label: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex flex-1 items-center justify-center gap-1.5 rounded-md py-1.5 text-xs font-medium transition-colors",
        active ? "bg-primary/10 text-primary" : "text-muted-foreground hover:bg-muted",
      )}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}
```

- [ ] **Step 4: 侧栏换 `Sidebar`** — `src/renderer/reader/ReaderView.tsx`：把 `import { ChapterList } from "@renderer/reader/ChapterList";` 改为 `import { Sidebar } from "@renderer/reader/Sidebar";`，并把 `<aside className="w-64 ...">` 内的 `<ChapterList bookId={bookId} />` 改为 `<Sidebar bookId={bookId} />`。

- [ ] **Step 5: typecheck + 全量测试**

Run: `pnpm typecheck && pnpm test 2>&1 | tail -4`
Expected: typecheck 无错误；全量测试通过。

- [ ] **Step 6: Commit**

```bash
git add src/renderer/reader/AnnotationsList.tsx src/renderer/reader/Sidebar.tsx src/renderer/reader/ReaderView.tsx
git commit -m "$(printf 'feat(reader): annotations sidebar tab with reading-order list and jump\n\nCo-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>')"
```

- [ ] **Step 7: 【手测检查点】最终回归** `pnpm start`：
- 侧栏「目录/标注」切换；标注页按阅读序列出（色条 + 原文 + ✎笔记 + 章名）。
- 点列表条目 → 正文滚到该标注所在 section。
- 全链路：建高亮（5 色 + 下划线）/ 加笔记 / 改样式 / 改笔记 / 删除 → 正文与列表同步；重开书恢复。
- CFI 完整性：建多条标注后选别处问 AI / 翻页进度，CFI 不乱。
- best-effort：（可选）人为破坏一条 cfiRange → 该高亮不渲染但仍在列表。

---

## 完成后

- 全部 12 任务过 + 各手测检查点通过 → **RA3 + M-b** 落地：标注持久化、6 样式高亮渲染、点击编辑、笔记 modal、侧栏列表跳转，CFI 锚定 + ignoreClass 防污染。
- 走 `finishing-a-development-branch` 合并；更新 ROADMAP：M-b → ✅、RA3 → ✅（`annotations` 表/IPC + UI 落地）。
- 解锁后续：RA4（摘要查看 + 跨章会话）、按章分组列表、CFI 失效模糊重定位、下划线颜色变体等（见 spec §10）。

## 刻意推迟（不在本计划，spec §10）

跨 section 高亮 · CFI 失效模糊重定位 / 「位置失效」标记 · 下划线颜色变体 · 笔记 modal 内选色 · 侧栏按章「分组标题」（本计划仅章名标签）· 标注导出 / 富文本 · 高亮跳回强调动画 · 会话页签（RA4）。
