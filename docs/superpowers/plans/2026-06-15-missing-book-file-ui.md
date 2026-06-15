# 缺失书文件的删除/重连 UI 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 打开书时若 app 自有副本文件缺失，渲染层呈现可操作的「文件缺失」面板——重连（选回内容一致的原文件，无缝恢复进度/标注/对话）或删除。

**Architecture:** `readBookBytes` IPC 通道改 safe-return 判别联合（仅「文件缺失」走 `{ok:false}`，意外错误仍 throw）以绕开 Electron 异常透传丢失 `error.name` 的问题；新增 `library:relink` 通道（弹文件选择器 + `sha256(bytes)==bookId` 严格校验后写回副本）；epub/pdf 两个 reader 共享一个 `BookFileMissingPanel`。删除完全复用既有 `library:delete`。

**Tech Stack:** Electron 41 IPC（Zod 契约单一真相源）、better-sqlite3/Drizzle、React 19 + React Compiler、@tanstack/react-query、sonner toast、Base UI AlertDialog、i18next。

**Spec:** `docs/superpowers/specs/2026-06-15-missing-book-file-ui-design.md`

---

## 关键约束（实现前必读）

- **`books.id` 恒为 `sha256(文件字节)`**（epub 与 pdf 一致，见 `repository.ts:79-81`）。重连校验 = `createHash("sha256").update(bytes).digest("hex") === bookId`。
- **IPC handler output 不做运行时校验**（`ipc.ts:116`，`out<O>()` 仅类型载体）——改 output 即改类型 + handler 返回结构 + 渲染层解包，无运行时 schema 改动。
- **`bindings-coverage.test.ts` 强制**每个 invoke 契约有且仅有一个 binding——新增 `library:relink` 契约**必须**同时加 binding，否则该测试红。
- **React Compiler 已启用**：别手写 `useCallback`/`useMemo`（命令式 effect 清理仍手写）。
- **日志规范**：优雅吞错处留 `log.warn`；handler 抛出的错误由 registry catch-all 自动落盘，无需重复记录。
- **commit 注意**：pre-commit hook（prek）会跑 `lint:fix` + `format` 并可能改暂存文件而中止提交。遇到时 `git add` 被改文件后**重跑同一条 commit**（第二次通过）。
- 本计划全程在分支 `feat/missing-book-file-ui` 上（spec 已提交于此）。

## 文件结构

| 文件                                           | 职责                          | 动作                                                 |
| ---------------------------------------------- | ----------------------------- | ---------------------------------------------------- |
| `src/main/library/book-files.ts`               | 书文件 IO + 派生路径          | 加 `relinkBookFile`、`readBookFileResult`            |
| `src/main/library/book-files.test.ts`          | 上者的单测                    | 加 4 个 case                                         |
| `src/shared/library.ts`                        | library 域 Zod/类型单一真相源 | 加 `ReadBookBytesResult`、`RelinkResult`             |
| `src/shared/ipc.ts`                            | IPC 契约单一真相源            | 改 `libraryReadBookBytes` output；加 `libraryRelink` |
| `src/preload-api.ts`                           | `window.api` 构建             | 暴露 `library.relink`                                |
| `src/main/ipc/library-handlers.ts`             | library 通道胶水层            | 改 `readBookBytes` handler；加 `relink` handler      |
| `src/renderer/reader/epub-session.tsx`         | epub 会话 context             | 解包 Result，暴露 `bytesMissing`/`bytesError`        |
| `src/renderer/reader/BookFileMissingPanel.tsx` | 缺失面板（epub/pdf 共享）     | 新建                                                 |
| `src/renderer/reader/EpubReader.tsx`           | epub 渲染                     | `bytesMissing` 分流到面板                            |
| `src/renderer/reader/PdfReader.tsx`            | pdf 渲染                      | 解包 Result + `bytesMissing` 分流                    |
| `src/shared/i18n/locales/{zh-CN,en}.ts`        | 文案                          | 加 `reader.missingFile.*`                            |

---

## Task 1: `relinkBookFile` 纯函数（TDD）

**Files:**

- Modify: `src/main/library/book-files.ts`
- Test: `src/main/library/book-files.test.ts`

- [ ] **Step 1: 写失败测试**（追加到 `book-files.test.ts` 的 `describe("book-files", ...)` 块内，最后一个 `it` 之后）

```ts
it("relinkBookFile writes bytes back when sha256 matches the bookId", async () => {
  const bytes = new Uint8Array([1, 2, 3, 4]);
  const bookId = createHash("sha256").update(bytes).digest("hex");
  const result = await relinkBookFile(dir, bookId, "epub", bytes);
  expect(result).toBe("ok");
  expect(new Uint8Array(await readFile(storedBookPath(dir, bookId, "epub")))).toEqual(bytes);
});

it("relinkBookFile returns mismatch and writes nothing when sha256 differs", async () => {
  const bytes = new Uint8Array([9, 9, 9]);
  const result = await relinkBookFile(dir, "not-the-right-hash", "epub", bytes);
  expect(result).toBe("mismatch");
  await expect(readBookFile(dir, "not-the-right-hash", "epub")).rejects.toBeInstanceOf(
    BookFileMissingError,
  );
});
```

并把 `relinkBookFile` 加入顶部 import（第 6-12 行的 `from "@main/library/book-files"`）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/library/book-files.test.ts`
Expected: FAIL —「relinkBookFile is not a function」/ 导入报错。

- [ ] **Step 3: 实现 `relinkBookFile`**（加到 `book-files.ts`，`writeBookFile` 之后）

```ts
/**
 * 重连：仅当选回文件的内容哈希等于原 bookId（= 同一文件）才写回副本。
 * 不匹配返回 "mismatch" 且不写任何东西，绝不污染库。format 由调用方从 books 行取并传入
 * （不调 detectFormat，避免 book-files ↔ repository 循环依赖）。
 */
export async function relinkBookFile(
  booksDir: string,
  bookId: string,
  format: BookFormat,
  bytes: Uint8Array,
): Promise<"ok" | "mismatch"> {
  const id = createHash("sha256").update(bytes).digest("hex");
  if (id !== bookId) return "mismatch";
  await writeBookFile(booksDir, bookId, format, bytes);
  return "ok";
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/library/book-files.test.ts`
Expected: PASS（含原有 6 个 + 新 2 个）。

- [ ] **Step 5: Commit**

```bash
git add src/main/library/book-files.ts src/main/library/book-files.test.ts
git commit -m "feat(library): add relinkBookFile content-hash guarded write-back (#27)"
```

---

## Task 2: `ReadBookBytesResult` 类型 + `readBookFileResult` 纯函数（TDD）

**Files:**

- Modify: `src/shared/library.ts`（加类型）
- Modify: `src/main/library/book-files.ts`（加函数）
- Test: `src/main/library/book-files.test.ts`

- [ ] **Step 1: 在 `src/shared/library.ts` 加类型**（追加到文件末尾）

```ts
/**
 * library:read-book-bytes 的返回契约。仅「文件缺失」走 ok:false（reason 预留为字面量联合，
 * 未来别的预期失败再扩）；其余意外错误仍由 handler throw（走 registry 落盘 + 渲染层 query.isError）。
 */
export type ReadBookBytesResult =
  | { ok: true; data: Uint8Array }
  | { ok: false; error: { reason: "missing" } };
```

- [ ] **Step 2: 写失败测试**（追加到 `book-files.test.ts` 块内）

```ts
it("readBookFileResult returns ok with bytes when the copy exists", async () => {
  const bytes = new Uint8Array([5, 6, 7]);
  await writeBookFile(dir, "book-x", "epub", bytes);
  expect(await readBookFileResult(dir, "book-x", "epub")).toEqual({ ok: true, data: bytes });
});

it("readBookFileResult returns missing when the copy is absent", async () => {
  expect(await readBookFileResult(dir, "gone", "epub")).toEqual({
    ok: false,
    error: { reason: "missing" },
  });
});
```

把 `readBookFileResult` 加入顶部 import。

- [ ] **Step 3: 跑测试确认失败**

Run: `pnpm test src/main/library/book-files.test.ts`
Expected: FAIL —「readBookFileResult is not a function」。

- [ ] **Step 4: 实现 `readBookFileResult`**（加到 `book-files.ts`，`readBookFile` 之后；并在文件顶部加 `import type { ReadBookBytesResult } from "@shared/library";`）

```ts
/** 读副本并把「文件缺失」收敛为 safe-return；其余意外错误原样 rethrow（交 handler/registry）。 */
export async function readBookFileResult(
  booksDir: string,
  bookId: string,
  format: BookFormat,
): Promise<ReadBookBytesResult> {
  try {
    const data = await readBookFile(booksDir, bookId, format);
    return { ok: true, data };
  } catch (err) {
    if (err instanceof BookFileMissingError) return { ok: false, error: { reason: "missing" } };
    throw err;
  }
}
```

- [ ] **Step 5: 跑测试 + typecheck 确认通过**

Run: `pnpm test src/main/library/book-files.test.ts && pnpm typecheck`
Expected: PASS（测试 4 新 case 全过；typecheck 绿——此时 IPC output 仍是 Uint8Array、handler 未改，无类型冲突）。

- [ ] **Step 6: Commit**

```bash
git add src/shared/library.ts src/main/library/book-files.ts src/main/library/book-files.test.ts
git commit -m "feat(library): add readBookFileResult safe-return wrapper (#27)"
```

---

## Task 3: 契约层接线（IPC 契约 + preload + 两个 handler）

> 这一步必须整体完成才能让 typecheck 与 `bindings-coverage.test.ts` 同时绿——改 output 类型会让旧 handler 返回值不匹配，新契约会让 coverage 测试要求对应 binding。故合为一个 task。

**Files:**

- Modify: `src/shared/ipc.ts`
- Modify: `src/preload-api.ts`
- Modify: `src/main/ipc/library-handlers.ts`

- [ ] **Step 1: `src/shared/library.ts` 加 `RelinkResult`**（追加到末尾）

```ts
/** library:relink 返回：ok=写回成功；canceled=用户取消选择；mismatch=选错文件（内容不一致）。 */
export type RelinkResult = { status: "ok" | "canceled" | "mismatch" };
```

- [ ] **Step 2: `src/shared/ipc.ts` 改 output + 加契约**

文件顶部 `import type { ... } from "@shared/library"`（第 3-10 行）的类型清单里加 `ReadBookBytesResult`、`RelinkResult`。

把第 130 行：

```ts
  libraryReadBookBytes: def("library:read-book-bytes", "invoke", bookIdInput, out<Uint8Array>()),
```

改为（output 换类型，并在其后新增 relink 契约）：

```ts
  libraryReadBookBytes: def(
    "library:read-book-bytes",
    "invoke",
    bookIdInput,
    out<ReadBookBytesResult>(),
  ),
  libraryRelink: def("library:relink", "invoke", bookIdInput, out<RelinkResult>()),
```

- [ ] **Step 3: `src/preload-api.ts` 暴露 relink**

在 `library:` 块（第 41-54 行）的 `readBookBytes: inv(C.libraryReadBookBytes),` 下一行加：

```ts
      relink: inv(C.libraryRelink),
```

- [ ] **Step 4: `src/main/ipc/library-handlers.ts` 改两个 handler**

顶部 import：第 19 行 `import { readBookFile, writeBookFile } from "@main/library/book-files";` 改为：

```ts
import {
  readBookFile,
  readBookFileResult,
  relinkBookFile,
  writeBookFile,
} from "@main/library/book-files";
```

把 `readBookBytes` handler（第 96-102 行）改为调 `readBookFileResult`：

```ts
  bind(C.libraryReadBookBytes, async (input) => {
    const db = getDb();
    const book = getBook(db, input.bookId);
    if (!book) throw new Error(`library: book ${input.bookId} not found`);
    await ensureEpubIndexed(input.bookId);
    return readBookFileResult(appService.getPath("booksDir"), input.bookId, book.format);
  }),
```

在 `libraryDelete` binding（第 104-106 行）之后新增 relink binding：

```ts
  bind(C.libraryRelink, async (input) => {
    const db = getDb();
    const book = getBook(db, input.bookId);
    if (!book) throw new Error(`library: book ${input.bookId} not found`);
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      properties: ["openFile" as const],
      filters: [{ name: "Books", extensions: ["epub", "pdf"] }],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || r.filePaths.length === 0) return { status: "canceled" as const };
    const bytes = await readBookBytes(r.filePaths[0]!);
    const result = await relinkBookFile(
      appService.getPath("booksDir"),
      input.bookId,
      book.format,
      bytes,
    );
    if (result === "ok") log.info(`book relinked: ${input.bookId}`);
    return { status: result };
  }),
```

> `readBookBytes`（import-source，读用户源文件）与 `BrowserWindow`/`dialog` 均已在本文件 import（第 1-2、20 行），无需新增。

- [ ] **Step 5: typecheck + coverage 测试确认绿**

Run: `pnpm typecheck && pnpm test src/main/ipc/bindings-coverage.test.ts`
Expected: PASS（handler 返回 `ReadBookBytesResult`/`RelinkResult` 匹配 output；relink 契约有了对应 binding，coverage 双向相等）。

- [ ] **Step 6: Commit**

```bash
git add src/shared/library.ts src/shared/ipc.ts src/preload-api.ts src/main/ipc/library-handlers.ts
git commit -m "feat(library): wire read-book-bytes safe-return + library:relink IPC (#27)"
```

---

## Task 4: `epub-session` 解包 Result

**Files:**

- Modify: `src/renderer/reader/epub-session.tsx`

- [ ] **Step 1: `EpubSession` 接口加 `bytesMissing`**（第 13-20 行 interface 内，`bytesError` 旁）

```ts
parseError: string | null;
/** app 自有副本缺失（safe-return ok:false）——EpubReader 据此挂缺失面板。 */
bytesMissing: boolean;
bytesError: boolean;
```

- [ ] **Step 2: 解包 `bytes.data`**（第 60-86 行的 useEffect）

把第 61 行 `if (!bytes.data) return;` 改为：

```ts
if (!bytes.data?.ok) return;
```

把第 65 行 `createEpubBook(bytes.data)` 改为：

```ts
createEpubBook(bytes.data.data);
```

（依赖数组 `[bytes.data]` 保持不变。）

- [ ] **Step 3: context value 暴露两个信号**（第 135-138 行）

```tsx
    <EpubSessionContext.Provider
      value={{
        book,
        spineHrefs,
        anchorBoundaries,
        parseError,
        bytesMissing: bytes.data?.ok === false,
        bytesError: bytes.isError,
      }}
    >
```

- [ ] **Step 4: typecheck 确认绿**

Run: `pnpm typecheck`
Expected: PASS（EpubReader 解构未取 `bytesMissing` 不报错；`bytes.data.data` 在 `ok` 收窄后可用）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/reader/epub-session.tsx
git commit -m "feat(reader): unpack read-book-bytes Result in epub session (#27)"
```

---

## Task 5: `BookFileMissingPanel` 组件 + i18n

**Files:**

- Create: `src/renderer/reader/BookFileMissingPanel.tsx`
- Modify: `src/shared/i18n/locales/zh-CN.ts`
- Modify: `src/shared/i18n/locales/en.ts`

- [ ] **Step 1: 创建组件 `BookFileMissingPanel.tsx`**

```tsx
import { useState } from "react";
import { useTranslation } from "react-i18next";
import { useQueryClient } from "@tanstack/react-query";
import { FileX2 } from "lucide-react";
import { toast } from "sonner";
import { qk } from "@renderer/query/keys";
import { Button } from "@renderer/components/ui/button";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogTitle,
} from "@renderer/components/ui/alert-dialog";
import { useNavigationStore } from "@renderer/store/navigation-store";

/** 书文件缺失时替换 reader 内容区：重连（内容一致才写回）/ 删除 / 返回书库。epub 与 pdf 共享。 */
export function BookFileMissingPanel({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const backToLibrary = useNavigationStore((s) => s.backToLibrary);
  const [confirmOpen, setConfirmOpen] = useState(false);

  const relink = async () => {
    const r = await window.api.library.relink({ bookId });
    if (r.status === "ok") {
      toast.success(t("reader.missingFile.relinked", "已重新连接文件"));
      void qc.invalidateQueries({ queryKey: qk.bookBytes(bookId) });
    } else if (r.status === "mismatch") {
      toast.error(t("reader.missingFile.mismatch", "这不是同一个文件（内容不一致）"), {
        closeButton: true,
        duration: Infinity,
      });
    }
    // canceled：无动作
  };

  const remove = async () => {
    setConfirmOpen(false);
    try {
      await window.api.library.delete({ bookId });
      backToLibrary();
    } catch (e) {
      toast.error(
        t("reader.missingFile.deleteFailed", "删除失败：{{error}}", {
          error: (e as Error).message,
        }),
        { closeButton: true, duration: Infinity },
      );
    }
  };

  return (
    <div className="flex h-full flex-col items-center justify-center gap-4 px-6 text-center">
      <FileX2 className="size-12 text-muted-foreground" />
      <div className="space-y-1">
        <p className="font-sans text-base font-medium text-foreground">
          {t("reader.missingFile.title", "这本书的文件不见了")}
        </p>
        <p className="max-w-sm font-sans text-sm text-muted-foreground">
          {t(
            "reader.missingFile.body",
            "文件可能被移动或删除。重新选择原文件可恢复阅读（含进度与标注），或从书库删除这本书。",
          )}
        </p>
      </div>
      <div className="flex items-center gap-2">
        <Button onClick={() => void relink()}>
          {t("reader.missingFile.relink", "重新选择文件")}
        </Button>
        <Button variant="outline" onClick={backToLibrary}>
          {t("reader.backToLibrary", "书库")}
        </Button>
        <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
          {t("reader.missingFile.delete", "从书库删除")}
        </Button>
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogTitle>
            {t("reader.missingFile.deleteConfirm.title", "从书库删除这本书？")}
          </AlertDialogTitle>
          <AlertDialogDescription>
            {t(
              "reader.missingFile.deleteConfirm.body",
              "将永久移除这本书及其所有标注、笔记、对话。此操作不可撤销。",
            )}
          </AlertDialogDescription>
          <AlertDialogFooter>
            <Button variant="outline" onClick={() => setConfirmOpen(false)}>
              {t("reader.missingFile.deleteConfirm.cancel", "取消")}
            </Button>
            <Button variant="destructive" onClick={() => void remove()}>
              {t("reader.missingFile.deleteConfirm.confirm", "删除")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
```

- [ ] **Step 2: zh-CN.ts 加文案**（按字母序就近插入到 `"reader.*"` 区，扁平 key）

```ts
  "reader.missingFile.title": "这本书的文件不见了",
  "reader.missingFile.body": "文件可能被移动或删除。重新选择原文件可恢复阅读（含进度与标注），或从书库删除这本书。",
  "reader.missingFile.relink": "重新选择文件",
  "reader.missingFile.relinked": "已重新连接文件",
  "reader.missingFile.mismatch": "这不是同一个文件（内容不一致）",
  "reader.missingFile.delete": "从书库删除",
  "reader.missingFile.deleteFailed": "删除失败：{{error}}",
  "reader.missingFile.deleteConfirm.title": "从书库删除这本书？",
  "reader.missingFile.deleteConfirm.body": "将永久移除这本书及其所有标注、笔记、对话。此操作不可撤销。",
  "reader.missingFile.deleteConfirm.cancel": "取消",
  "reader.missingFile.deleteConfirm.confirm": "删除",
```

- [ ] **Step 3: en.ts 加同名 key**

```ts
  "reader.missingFile.title": "This book's file is missing",
  "reader.missingFile.body": "The file may have been moved or deleted. Pick the original file to resume reading (progress and annotations are kept), or remove this book from the library.",
  "reader.missingFile.relink": "Choose file again",
  "reader.missingFile.relinked": "File reconnected",
  "reader.missingFile.mismatch": "That's not the same file (content differs)",
  "reader.missingFile.delete": "Remove from library",
  "reader.missingFile.deleteFailed": "Delete failed: {{error}}",
  "reader.missingFile.deleteConfirm.title": "Remove this book from the library?",
  "reader.missingFile.deleteConfirm.body": "This permanently removes the book and all its annotations, notes, and conversations. This cannot be undone.",
  "reader.missingFile.deleteConfirm.cancel": "Cancel",
  "reader.missingFile.deleteConfirm.confirm": "Delete",
```

- [ ] **Step 4: typecheck + i18n lint**

Run: `pnpm typecheck && pnpm i18n:lint`
Expected: PASS（组件自包含；两 locale key 对齐无缺漏）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/reader/BookFileMissingPanel.tsx src/shared/i18n/locales/zh-CN.ts src/shared/i18n/locales/en.ts
git commit -m "feat(reader): add BookFileMissingPanel with relink/delete actions (#27)"
```

---

## Task 6: EpubReader 接线（缺失 → 面板）

**Files:**

- Modify: `src/renderer/reader/EpubReader.tsx`

- [ ] **Step 1: import 组件**（顶部 import 区，第 18 行 `useEpubSession` import 旁）

```ts
import { BookFileMissingPanel } from "./BookFileMissingPanel";
```

- [ ] **Step 2: 解构加 `bytesMissing`**（第 55 行）

```ts
const { book, parseError, bytesError, bytesMissing } = useEpubSession();
```

- [ ] **Step 3: 缺失优先分流**（第 366 行 `if (bytesError)` 之前插入）

```tsx
if (bytesMissing) return <BookFileMissingPanel bookId={bookId} />;
```

- [ ] **Step 4: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/reader/EpubReader.tsx
git commit -m "feat(reader): show missing-file panel for epub (#27)"
```

---

## Task 7: PdfReader 接线（解包 Result + 缺失 → 面板）

**Files:**

- Modify: `src/renderer/reader/PdfReader.tsx`

- [ ] **Step 1: import 组件**（顶部 import 区，第 14 行 `createPdfBook` import 旁）

```ts
import { BookFileMissingPanel } from "./BookFileMissingPanel";
```

- [ ] **Step 2: 解包 `bytes.data`**（第 105、109 行的 useEffect）

把第 105 行 `if (!bytes.data) return;` 改为：

```ts
if (!bytes.data?.ok) return;
```

把第 109 行 `createPdfBook(bytes.data)` 改为：

```ts
createPdfBook(bytes.data.data);
```

- [ ] **Step 3: 缺失分流**（第 332 行 `if (bytes.isError)` 之前插入）

```tsx
if (bytes.data?.ok === false) return <BookFileMissingPanel bookId={bookId} />;
```

- [ ] **Step 4: typecheck + lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/reader/PdfReader.tsx
git commit -m "feat(reader): show missing-file panel for pdf (#27)"
```

---

## Task 8: 全量验证 + 手动冒烟 + changeset

**Files:**

- Create: `.changeset/missing-book-file-ui.md`

- [ ] **Step 1: 全量绿灯**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: 全 PASS。

- [ ] **Step 2: 手动冒烟（dev app，用隔离 user-data 避免污染真实库）**

参考 memory `dev-cdp-smoke-args-gotcha`：dev 也吃 `--user-data-dir`，透传开关恰好一个 `--`。流程：

1. `pnpm start` 起 dev，导入一本 epub 与一本 pdf，各读几页（产生进度/标注）。
2. 退出 app，到 dev userData 的 `books/` 目录手动删除这两本的副本文件（`<sha256(bookId)>.epub|.pdf`）。
3. 重新 `pnpm start`，打开这两本 → 应显示 `BookFileMissingPanel`（不是死文案）。
4. **重连成功**：点「重新选择文件」选回原文件 → toast「已重新连接」→ 自动恢复阅读，进度/标注还在。
5. **选错文件**：点「重新选择文件」选另一本不同的书 → toast「这不是同一个文件」，面板留存可重试。
6. **删除**：点「从书库删除」→ 确认 → 回到书库且该书消失。

Expected: 四条路径均符合预期；epub 与 pdf 表现一致。

- [ ] **Step 3: 写 changeset**

创建 `.changeset/missing-book-file-ui.md`（package 名与 `.changeset/` 内既有条目一致；通常为根包名）：

```md
---
"marginalia": minor
---

Recover from missing book files: when a book's stored copy is gone, the reader now shows a recovery panel offering to relink the original file (restoring reading progress and annotations) or remove the book from the library, instead of a dead error message.
```

- [ ] **Step 4: Commit**

```bash
git add .changeset/missing-book-file-ui.md
git commit -m "chore: add changeset for missing book file UI (#27)"
```

---

## 完成判据

- `pnpm typecheck && pnpm lint && pnpm test` 全绿。
- epub 与 pdf 打开缺失书都显示 `BookFileMissingPanel`；重连成功/选错/删除三条路径手动冒烟通过。
- 重连成功后进度与标注无缝保留（同 bookId、副本补回）。
- `library:relink` 已被 `bindings-coverage.test.ts` 覆盖；`readBookBytes` 改 safe-return 后仅此通道、未波及其他通道（#24 范畴留作后续）。
