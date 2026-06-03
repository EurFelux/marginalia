# 书库拖拽导入 ePub 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在书库界面支持从操作系统拖入 `.epub` 文件批量导入，拖入窗口时浮现居中投放卡片，拖到卡片上时给激活样式。

**Architecture:** 纯逻辑（文件过滤、文件名提取）抽到 `epub-drop.ts` 可单测；拖拽状态机 `use-epub-drop.ts`（计数器治抖动）+ 展示组件 `DropOverlay.tsx`；preload 经 `webUtils.getPathForFile` 暴露 `pathForFile`（Electron 41 已移除 `File.path`）；`LibraryView` 把按钮导入与拖拽导入收敛到同一个吃路径数组的批量 mutation。

**Tech Stack:** React 19（启用 React Compiler，勿手写 useCallback/useMemo）+ TanStack Query + Electron `webUtils` + Tailwind + lucide-react + vitest（仅测纯逻辑）。

**设计来源:** `docs/superpowers/specs/2026-06-03-library-drag-drop-import-design.md`

**测试策略说明（重要）:** 本仓库既有惯例是**只对纯逻辑做 vitest 单测**（对标 `chapter-id-by-href.test.ts`、`epub-selection.ts` 等），renderer 没有 React/DOM 渲染测试框架。故 Task 1（纯 helper）走完整 TDD；Task 2–5（preload Electron 绑定、拖拽 hook、展示组件、视图接线）以 `pnpm typecheck` + Task 6 手动验证兜底，**这不是省略纪律，而是匹配既有可测边界**（DOM 拖拽事件、`webUtils`、React 渲染都依赖 Electron/浏览器运行时，无法在 headless vitest 里有意义地测）。

---

### Task 1: 纯逻辑 helper `epub-drop.ts`（TDD）

**Files:**

- Create: `src/renderer/library/epub-drop.ts`
- Test: `src/renderer/library/epub-drop.test.ts`

- [ ] **Step 1: 写失败测试**

`src/renderer/library/epub-drop.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { fileNameOf, isFilesDrag, pickEpubFiles } from "./epub-drop";

describe("isFilesDrag", () => {
  it("returns true when the drag payload includes external files", () => {
    expect(isFilesDrag(["Files"])).toBe(true);
  });
  it("returns false for text/internal drags and empty payloads", () => {
    expect(isFilesDrag(["text/plain"])).toBe(false);
    expect(isFilesDrag([])).toBe(false);
  });
});

describe("pickEpubFiles", () => {
  const names = (files: { name: string }[]) => files.map((f) => f.name);

  it("keeps only .epub in epubs, the rest in ignored", () => {
    const { epubs, ignored } = pickEpubFiles([
      { name: "a.epub" },
      { name: "b.pdf" },
      { name: "c.epub" },
    ]);
    expect(names(epubs)).toEqual(["a.epub", "c.epub"]);
    expect(names(ignored)).toEqual(["b.pdf"]);
  });
  it("matches the .epub extension case-insensitively", () => {
    expect(names(pickEpubFiles([{ name: "Book.EPUB" }]).epubs)).toEqual(["Book.EPUB"]);
  });
  it("treats folders (no extension) as ignored", () => {
    const { epubs, ignored } = pickEpubFiles([{ name: "MyFolder" }]);
    expect(epubs).toEqual([]);
    expect(names(ignored)).toEqual(["MyFolder"]);
  });
  it("returns empty groups for an empty list", () => {
    expect(pickEpubFiles([])).toEqual({ epubs: [], ignored: [] });
  });
  it("preserves input order", () => {
    expect(names(pickEpubFiles([{ name: "2.epub" }, { name: "1.epub" }]).epubs)).toEqual([
      "2.epub",
      "1.epub",
    ]);
  });
});

describe("fileNameOf", () => {
  it("extracts the basename from a posix path", () => {
    expect(fileNameOf("/Users/a/b/Book.epub")).toBe("Book.epub");
  });
  it("extracts the basename from a windows path", () => {
    expect(fileNameOf("C:\\books\\Book.epub")).toBe("Book.epub");
  });
  it("returns the input when there is no separator", () => {
    expect(fileNameOf("Book.epub")).toBe("Book.epub");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/library/epub-drop.test.ts`
Expected: FAIL（`Cannot find module './epub-drop'` 或导出未定义）

- [ ] **Step 3: 写最小实现**

`src/renderer/library/epub-drop.ts`:

```ts
/** 仅当拖拽负载含「外部文件」时才响应——忽略选区文本拖拽、内部元素拖拽。 */
export function isFilesDrag(types: readonly string[]): boolean {
  return types.includes("Files");
}

export interface SortedDrop<T> {
  epubs: T[];
  ignored: T[];
}

/**
 * 按 .epub 后缀（大小写不敏感）把拖入项分组：命中进 epubs，其余进 ignored。
 * 不依赖 MIME（epub 的 type 上报不稳定）；文件夹/pdf/txt 均无 .epub 后缀 → ignored。
 * 泛型保留真实 File 类型；输入顺序保留，便于稳定断言。
 */
export function pickEpubFiles<T extends { name: string }>(files: readonly T[]): SortedDrop<T> {
  const epubs: T[] = [];
  const ignored: T[] = [];
  for (const f of files) {
    if (f.name.toLowerCase().endsWith(".epub")) epubs.push(f);
    else ignored.push(f);
  }
  return { epubs, ignored };
}

/** 取路径末段文件名（按钮导入路径的失败提示用）。兼容 / 与 \ 分隔。 */
export function fileNameOf(path: string): string {
  const seg = path.split(/[\\/]/);
  return seg[seg.length - 1] || path;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/library/epub-drop.test.ts`
Expected: PASS（14 个断言全绿）

- [ ] **Step 5: 提交**

```bash
git add src/renderer/library/epub-drop.ts src/renderer/library/epub-drop.test.ts
git commit -m "feat(library): add epub-drop pure helpers (filter/basename)"
```

---

### Task 2: preload 暴露 `pathForFile`

**Files:**

- Modify: `src/preload.ts`（electron import 加 `webUtils`；`api.library` 加 `pathForFile`）

**无单测理由:** `webUtils.getPathForFile` 是 Electron 渲染端绑定，headless vitest 无 `webUtils`、无法有意义地测；以 typecheck + Task 6 手验兜底。

- [ ] **Step 1: 给 electron import 加 `webUtils`**

把 `src/preload.ts` 第 1 行：

```ts
import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
```

改为：

```ts
import { contextBridge, ipcRenderer, webUtils, type IpcRendererEvent } from "electron";
```

- [ ] **Step 2: 在 `api.library` 里加 `pathForFile`**

在 `src/preload.ts` 的 `library:` 对象内，`readEpubBytes` 之后加一行（注意上一行补逗号）：

```ts
    readEpubBytes: (input: BookIdInput): Promise<Uint8Array> =>
      ipcRenderer.invoke(IPC.libraryReadEpubBytes, input),
    /** 由拖入的 File 取磁盘路径（Electron 41 已移除 File.path，须经 webUtils）。同步、纯渲染端、非 IPC。 */
    pathForFile: (file: File): string => webUtils.getPathForFile(file),
```

- [ ] **Step 3: typecheck 确认 RendererApi 自动覆盖类型**

Run: `pnpm typecheck`
Expected: 通过，无错误（`window.api.library.pathForFile` 随 `RendererApi = typeof api` 自动可用）

- [ ] **Step 4: 提交**

```bash
git add src/preload.ts
git commit -m "feat(preload): expose library.pathForFile via webUtils.getPathForFile"
```

---

### Task 3: 拖拽状态机 hook `use-epub-drop.ts`

**Files:**

- Create: `src/renderer/library/use-epub-drop.ts`

**无单测理由:** DOM 拖拽事件（dragenter/leave/over/drop）依赖浏览器运行时，本仓库无 React/DOM 测试框架；以 typecheck + Task 6 手验兜底。

- [ ] **Step 1: 写 hook 实现**

`src/renderer/library/use-epub-drop.ts`:

```ts
import { useRef, useState, type DragEvent } from "react";
import { isFilesDrag } from "./epub-drop";

export interface EpubDropHandlers {
  onDragEnter: (e: DragEvent<HTMLDivElement>) => void;
  onDragOver: (e: DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: DragEvent<HTMLDivElement>) => void;
  onDrop: (e: DragEvent<HTMLDivElement>) => void;
}

export interface UseEpubDrop {
  /** 文件拖入窗口（→ 显示 overlay）。 */
  isDragging: boolean;
  /** 指针在投放卡片上（→ 激活样式）。 */
  isOverZone: boolean;
  /** 接到书库根容器：驱动 overlay 显隐 + 暗背景落点取消。 */
  rootHandlers: EpubDropHandlers;
  /** 接到投放卡片：驱动激活 + 命中导入。 */
  zoneHandlers: EpubDropHandlers;
}

/**
 * 书库文件拖拽状态机。
 * - 根节点计数器驱动 overlay 显隐：仅当拖拽负载含外部文件（isFilesDrag）才进入拖拽态。
 * - 卡片计数器驱动激活样式。两套计数器分别治 dragenter/dragleave 因子元素冒泡造成的闪烁。
 * - drop 落卡片 → onFiles(files)；落暗背景（冒泡到根）→ 取消、不导入。
 * - dragover 必须 preventDefault 才允许 drop。
 */
export function useEpubDrop(onFiles: (files: File[]) => void): UseEpubDrop {
  const [isDragging, setDragging] = useState(false);
  const [isOverZone, setOverZone] = useState(false);
  const rootCount = useRef(0);
  const zoneCount = useRef(0);

  const reset = () => {
    rootCount.current = 0;
    zoneCount.current = 0;
    setDragging(false);
    setOverZone(false);
  };

  const rootHandlers: EpubDropHandlers = {
    onDragEnter: (e) => {
      if (!isFilesDrag(e.dataTransfer.types)) return;
      e.preventDefault();
      rootCount.current += 1;
      setDragging(true);
    },
    onDragOver: (e) => {
      if (!isFilesDrag(e.dataTransfer.types)) return;
      e.preventDefault(); // 允许 drop
    },
    onDragLeave: (e) => {
      if (!isFilesDrag(e.dataTransfer.types)) return;
      rootCount.current -= 1;
      if (rootCount.current <= 0) reset();
    },
    onDrop: (e) => {
      e.preventDefault(); // 落暗背景：取消
      reset();
    },
  };

  const zoneHandlers: EpubDropHandlers = {
    onDragEnter: (e) => {
      e.preventDefault();
      zoneCount.current += 1;
      setOverZone(true);
    },
    onDragOver: (e) => {
      e.preventDefault();
    },
    onDragLeave: (e) => {
      zoneCount.current -= 1;
      if (zoneCount.current <= 0) setOverZone(false);
    },
    onDrop: (e) => {
      e.preventDefault();
      e.stopPropagation(); // 阻止冒泡到 rootHandlers.onDrop（否则会被当成取消）
      const files = Array.from(e.dataTransfer.files); // 必须在任何 await 前同步读取
      reset();
      onFiles(files);
    },
  };

  return { isDragging, isOverZone, rootHandlers, zoneHandlers };
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 通过（此文件暂未被引用，仅验证自身类型）

- [ ] **Step 3: 提交**

```bash
git add src/renderer/library/use-epub-drop.ts
git commit -m "feat(library): add useEpubDrop drag state machine hook"
```

---

### Task 4: 展示组件 `DropOverlay.tsx`

**Files:**

- Create: `src/renderer/library/DropOverlay.tsx`

**无单测理由:** 纯展示 React 组件，无渲染测试框架；以 typecheck + Task 6 手验兜底。

- [ ] **Step 1: 写组件**

`src/renderer/library/DropOverlay.tsx`:

```tsx
import { Download } from "lucide-react";
import { cn } from "@renderer/lib/utils";
import type { EpubDropHandlers } from "./use-epub-drop";

/**
 * 居中投放卡片 overlay（暗背景 + 虚线卡片）。
 * active=指针在卡片上 → accent 激活样式。zoneHandlers 接在卡片上（drop 落卡片才导入）。
 * 容器铺满视口、是书库根的 DOM 子节点，拖拽事件经冒泡回到 rootHandlers。
 */
export function DropOverlay({
  active,
  zoneHandlers,
}: {
  active: boolean;
  zoneHandlers: EpubDropHandlers;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 font-sans">
      <div
        {...zoneHandlers}
        className={cn(
          "flex flex-col items-center gap-3 rounded-2xl border-2 border-dashed px-12 py-10 text-center transition",
          active
            ? "scale-105 border-primary bg-primary/10 text-primary ring-4 ring-primary/25"
            : "border-muted-foreground/40 bg-popover/60 text-muted-foreground",
        )}
      >
        <Download className="size-10" />
        <p className="text-base font-medium">{active ? "松手即导入" : "拖放 ePub 到此导入"}</p>
        <p className="text-xs opacity-70">支持一次拖入多本，非 ePub 会被忽略</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 通过

- [ ] **Step 3: 提交**

```bash
git add src/renderer/library/DropOverlay.tsx
git commit -m "feat(library): add DropOverlay centered drop-card component"
```

---

### Task 5: 接线 `LibraryView.tsx`（批量导入 + overlay + 结果反馈）

**Files:**

- Modify: `src/renderer/library/LibraryView.tsx`（整文件替换）

**无单测理由:** 视图接线 + IPC mutation，无 React 测试框架；批量聚合逻辑足够简单、内联即可；以 typecheck + 全量 `pnpm test`（确保未破坏既有）+ Task 6 手验兜底。

**对 spec 的有意简化:** spec §⑤ 提到「导入中 2/5…」式逐项进度；此处简化为单一「导入中…」标签（顺序导入很快，加逐项计数器需在 mutationFn 内 setState、收益低），属 YAGNI 取舍。下方代码即最终形态。

- [ ] **Step 1: 整体替换 `LibraryView.tsx`**

`src/renderer/library/LibraryView.tsx`:

```tsx
import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FolderOpen, Settings } from "lucide-react";
import { Button } from "@renderer/components/ui/button";
import { qk } from "@renderer/query/keys";
import { useReaderStore } from "@renderer/store/reader-store";
import { useSettingsStore } from "@renderer/store/settings-store";
import { fileNameOf, pickEpubFiles } from "./epub-drop";
import { useEpubDrop } from "./use-epub-drop";
import { DropOverlay } from "./DropOverlay";

interface ImportItem {
  filePath: string;
  name: string;
}

interface ImportSummary {
  imported: number;
  failed: { name: string; error: string }[];
  ignored: string[];
}

export function LibraryView() {
  const qc = useQueryClient();
  const openBook = useReaderStore((s) => s.openBook);
  const openSettings = useSettingsStore((s) => s.setOpen);
  const books = useQuery({ queryKey: qk.library, queryFn: () => window.api.library.list() });
  const [summary, setSummary] = useState<ImportSummary | null>(null);

  // 按钮导入与拖拽导入收敛到同一批量 mutation：顺序逐本导入，聚合成功数与失败项。
  const importBooks = useMutation({
    mutationFn: async (items: ImportItem[]) => {
      const failed: { name: string; error: string }[] = [];
      let imported = 0;
      for (const it of items) {
        try {
          await window.api.library.import({ filePath: it.filePath });
          imported += 1;
        } catch (e) {
          failed.push({ name: it.name, error: (e as Error).message });
        }
      }
      return { imported, failed };
    },
    onSuccess: (r) => {
      if (r.imported > 0) void qc.invalidateQueries({ queryKey: qk.library });
    },
  });

  const runImport = async (items: ImportItem[], ignored: string[]) => {
    if (items.length === 0 && ignored.length === 0) return;
    setSummary(null);
    const r = items.length > 0 ? await importBooks.mutateAsync(items) : { imported: 0, failed: [] };
    setSummary({ imported: r.imported, failed: r.failed, ignored });
  };

  // 拖拽落卡片：过滤 epub → 取路径 → 批量导入；忽略项进汇总。
  const onFiles = (files: File[]) => {
    const { epubs, ignored } = pickEpubFiles(files);
    const items = epubs.map((f) => ({ filePath: window.api.library.pathForFile(f), name: f.name }));
    void runImport(
      items,
      ignored.map((f) => f.name),
    );
  };

  // 按钮导入：原生对话框取单个路径 → 同一批量通道。
  const onPick = async () => {
    const filePath = await window.api.library.pickEpub();
    if (!filePath) return;
    void runImport([{ filePath, name: fileNameOf(filePath) }], []);
  };

  const { isDragging, isOverZone, rootHandlers, zoneHandlers } = useEpubDrop(onFiles);

  return (
    <div
      {...rootHandlers}
      className="flex h-screen flex-col bg-background font-sans text-foreground"
    >
      <header className="flex h-14 shrink-0 items-center justify-between border-b border-border px-6">
        <h1 className="font-serif text-xl font-semibold">Marginalia</h1>
        <div className="flex items-center gap-2">
          <Button onClick={() => void onPick()} disabled={importBooks.isPending}>
            <FolderOpen />
            {importBooks.isPending ? "导入中…" : "导入 ePub"}
          </Button>
          <Button
            variant="ghost"
            size="icon"
            onClick={() => openSettings(true)}
            aria-label="设置"
            className="text-muted-foreground"
          >
            <Settings />
          </Button>
        </div>
      </header>

      <main className="flex-1 overflow-y-auto p-6">
        {summary && (
          <div className="mb-4 space-y-1 text-sm">
            {summary.imported > 0 && (
              <p className="text-muted-foreground">已导入 {summary.imported} 本。</p>
            )}
            {summary.failed.length > 0 && (
              <div className="text-destructive">
                <p>{summary.failed.length} 本导入失败：</p>
                <ul className="list-disc pl-5">
                  {summary.failed.map((f) => (
                    <li key={f.name}>
                      {f.name}：{f.error}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            {summary.ignored.length > 0 && (
              <p className="text-muted-foreground">
                已忽略 {summary.ignored.length} 个非 ePub 文件：{summary.ignored.join("、")}
              </p>
            )}
          </div>
        )}
        {books.isPending && <p className="text-sm text-muted-foreground">加载书库…</p>}
        {books.isError && <p className="text-sm text-destructive">读取书库失败</p>}
        {books.data?.length === 0 && (
          <div className="mt-20 text-center text-muted-foreground">
            <BookOpen className="mx-auto mb-3 size-10 opacity-40" />
            <p className="text-sm">书库为空，点右上角「导入 ePub」或把 .epub 拖进窗口开始。</p>
          </div>
        )}
        <ul className="grid grid-cols-[repeat(auto-fill,minmax(220px,1fr))] gap-3">
          {books.data?.map((b) => (
            <li key={b.id}>
              <button
                onClick={() => openBook(b.id)}
                className="flex w-full items-center gap-3 rounded-xl border border-border bg-card/60 p-3 text-left hover:bg-muted"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-lg bg-primary/10 text-primary">
                  <BookOpen className="size-5" />
                </span>
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium">{b.title ?? b.id}</span>
                  <span className="block truncate text-xs text-muted-foreground">
                    {b.author ?? "未知作者"}
                  </span>
                </span>
              </button>
            </li>
          ))}
        </ul>
      </main>

      {isDragging && <DropOverlay active={isOverZone} zoneHandlers={zoneHandlers} />}
    </div>
  );
}
```

- [ ] **Step 2: typecheck**

Run: `pnpm typecheck`
Expected: 通过

- [ ] **Step 3: 跑全量测试确认未破坏既有**

Run: `pnpm test`
Expected: 全绿（既有 269 测试 + 新增 epub-drop 测试），0 失败

- [ ] **Step 4: lint**

Run: `pnpm lint`
Expected: 无 error

- [ ] **Step 5: 提交**

```bash
git add src/renderer/library/LibraryView.tsx
git commit -m "feat(library): drag-drop epub import with drop-card overlay"
```

---

### Task 6: 手动验证（`pnpm start`）

**无法自动化:** 拖拽是 OS↔渲染层交互，必须真机验证。

- [ ] **Step 1: 启动 app**

Run: `pnpm start`（会阻塞；验证完 Ctrl-C）

- [ ] **Step 2: 逐项验证拖拽场景**

- [ ] 从 Finder 拖**单个** `.epub` 进窗口：窗口压暗 + 中央卡片浮现（被动样式）→ 移到卡片上变 accent 激活 + 文案「松手即导入」→ 松手导入，书库刷新出现新书。
- [ ] 拖**多个** `.epub`：松手后批量导入，汇总显示「已导入 N 本」。
- [ ] 拖**混合**（如 2 epub + 1 pdf + 1 文件夹）：只导 epub，汇总显示「已忽略 K 个非 ePub 文件：…」。
- [ ] 拖到卡片**外的暗背景**松手：overlay 消失、**不导入**（取消语义）。
- [ ] 拖**纯非 epub**（如单个 pdf）：松手后仅显示忽略提示，无导入。
- [ ] 拖进后**移出窗口**再松手（拖到桌面）：overlay 干净消失，无悬挂。
- [ ] 拖入**已存在**的同一本书：导入幂等，不报错、书库不重复。
- [ ] 制造失败用例（如把一个非 epub 改名为 `x.epub` 拖入）：汇总显示「失败」+ **主进程真实错误信息**（验证错误透传、未编造）。
- [ ] 打开一本书进阅读器，确认阅读器内拖文件**不触发** overlay（作用域仅书库）。

- [ ] **Step 3: 如有问题回到对应 Task 修复并重新提交；全部通过则进入收尾**

---

### 收尾

- [ ] 全量 `pnpm typecheck && pnpm test && pnpm lint` 均绿
- [ ] 走 `superpowers:finishing-a-development-branch`：更新 `docs/superpowers/ROADMAP.md`，合并/PR 决策
