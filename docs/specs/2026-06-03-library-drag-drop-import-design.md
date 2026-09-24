# 设计：书库拖拽导入 ePub

> 状态：已批准设计，待写实现计划（plans/）。
> 日期：2026-06-03

## 目标

在**书库界面**支持从操作系统（Finder/资源管理器等）拖入 `.epub` 文件直接导入。交互上需两个可区分的状态：

1. 文件拖入应用窗口时，浮现一个**导入区域**（投放卡片）。
2. 文件移动到导入区域上方时，给该区域**明显的激活样式**。

选定视觉方向：**居中投放卡片**（窗口压暗 + 中央虚线卡片）。卡片本身是投放目标，"窗口 ≠ 卡片" 的空间分离天然把上述两态拉开。

## 范围与既有约束

- 现有导入链路是**路径制**：`pickEpub()`（原生对话框）→ `filePath` → `library:import` IPC → 主进程按路径读文件（`library-handlers.ts` 的 `importBookInput` = `{ filePath: string }`）。拖拽导入**复用**这条链路，不在渲染层读字节走 IPC（大文件浪费）。
- **Electron 41 已移除 `File.path`**（Electron 32+ 起）。从拖入的 DOM `File` 取磁盘路径必须用 `webUtils.getPathForFile(file)`，经 preload contextBridge 暴露。代码库当前无任何 `webUtils` 用法。
- `App.tsx` 按 `view` 条件渲染 `<ReaderView/>` / `<LibraryView/>`——**读书时 LibraryView 卸载**。拖拽监听挂在 LibraryView 根节点上，作用域隔离由挂载边界免费保证，无需运行时守卫。
- `window.api` 类型 = `RendererApi = typeof api`（preload 推导）。往 api 对象加 `pathForFile` 后渲染层类型自动覆盖，无需手改 `global.d.ts`。

## 决策记录（来自 brainstorm）

| 决策点         | 选择                                                         |
| -------------- | ------------------------------------------------------------ |
| 视觉形态       | 方案 1 · 居中投放卡片（暗背景 + 中央虚线卡片）               |
| 多文件         | **支持批量**：一次拖入多个 epub 逐个导入，汇总成功/失败      |
| 非 epub / 混杂 | **过滤 epub 并提示忽略项**：只导 `.epub`，被跳过的用提示告知 |
| 投放目标       | 卡片为唯一 drop 目标；落在暗背景上取消（不导入）             |
| 导入并发       | 顺序循环（better-sqlite3 同步写、错误归因清晰）              |
| 重复导入       | 沿用既有幂等（epub 自然键为主键）                            |

## 文件清单

**新增**

- `src/renderer/library/epub-drop.ts` — 纯逻辑 helper
- `src/renderer/library/epub-drop.test.ts` — 单测
- `src/renderer/library/DropOverlay.tsx` — 纯展示 overlay
- `src/renderer/library/use-epub-drop.ts` — 拖拽状态 hook

**改动**

- `src/preload.ts` — `api.library` 下加 `pathForFile`
- `src/renderer/library/LibraryView.tsx` — 接线 hook + overlay，导入逻辑改批量

## 组件与职责

### 纯逻辑 `epub-drop.ts`

```ts
export function isFilesDrag(types: readonly string[]): boolean {
  return types.includes("Files"); // 只对「外部文件」拖拽响应，忽略选区文本/内部拖拽
}

export interface SortedDrop<T> {
  epubs: T[];
  ignored: T[];
}

export function pickEpubFiles<T extends { name: string }>(files: readonly T[]): SortedDrop<T>;
```

- `pickEpubFiles`：按 `.epub` 后缀（大小写不敏感）分组。命中进 `epubs`，其余（pdf/txt/拖入的文件夹均无 `.epub` 后缀）进 `ignored`。**不依赖 MIME**（epub 的 MIME 上报不稳定）。
- 泛型保留真实 `File` 类型；测试传 `{ name }` 形状即可，无需真 `File` 全局。
- 输入输出顺序保留（结果稳定、可断言）。

### 拖拽状态 hook `use-epub-drop.ts`

- **计数器治抖动**：`dragenter` +1 / `dragleave` −1，`isDragging = count>0`，`drop` 后归零。根节点与卡片各持一套计数，抵消子元素冒泡造成的闪烁。
- **进入条件**：仅当 `isFilesDrag(e.dataTransfer.types)` 为真才进入拖拽态。
- **两态输出**：`isDragging`（窗口内 → 卡片被动浮现）、`isOverZone`（指针在卡片上 → 激活）。
- **drop 语义**：卡片是唯一投放目标——落卡片上 → 回调 `onDrop(files)`；落暗背景上 → 取消（归零，不导入）。"激活 = 会导入" 语义自洽。
- `dragover` 必须 `preventDefault()` 才允许 drop。
- 导出 `{ isDragging, isOverZone, rootHandlers, zoneHandlers }`。

### 展示组件 `DropOverlay.tsx`

纯展示，零逻辑，受控于 `active`（= `isOverZone`）prop：

- 容器：`fixed inset-0 z-50 flex items-center justify-center bg-foreground/40`
- 卡片：`rounded-2xl border-2 border-dashed px-10 py-8 text-center transition`
  - 被动：`border-muted-foreground/40 bg-popover/60 text-muted-foreground`
  - 激活：`border-primary bg-primary/10 text-primary scale-105 ring-4 ring-primary/25`
- 图标 lucide（`Download` / `FileDown`）；文案「拖放 ePub 到此导入」↔ 激活「松手即导入」。
- 全静态 Tailwind 工具类，**无内联 `style`**，符合项目样式规范。

### preload `pathForFile`

```ts
import { webUtils } from "electron";
// api.library 内：
pathForFile: (file: File): string => webUtils.getPathForFile(file),
```

同步、纯渲染端（非 IPC）。加进 api 对象后 `RendererApi` 自动覆盖类型。

### `LibraryView.tsx` 接线与批量导入

导入统一为一个吃 `string[]`（路径数组）的 mutation——按钮与拖拽两条入口共享核心：

- **mutationFn(paths)**：顺序循环逐本 `library.import({ filePath })`，收集 `{ imported: BookSummaryDto[], failed: { name, error }[] }`。
- **onSuccess**：有任一成功 → `invalidateQueries(qk.library)`。
- **按钮路径**：`pickEpub()` → `[path]` → `mutate`。
- **拖拽路径**：`pickEpubFiles(Array.from(files))` → `epubs.map(pathForFile)` → `mutate`；`ignored` 暂存供提示。
- drop 瞬间 overlay 关闭；导入中按钮区显示「导入中 2/5…」式进度。

## 结果反馈

主区一条结构化汇总（取代现有单行红字），遵守项目「错误信息不许编造」约定：

- ✅ 成功 N 本（短暂提示）
- ❌ 失败 M 本：列文件名 + **透传主进程真实 error message**
- ⚠️ 忽略 K 个非 epub：列名字

## 数据流

```
OS 拖拽
  → LibraryView 根 (rootHandlers): isFilesDrag? → isDragging=true → 渲染 DropOverlay
  → 卡片 (zoneHandlers): dragenter → isOverZone=true（激活样式）
  → drop on 卡片:
       pickEpubFiles(Array.from(files)) → { epubs, ignored }
       paths = epubs.map(window.api.library.pathForFile)
       importBooks.mutate(paths)  // 顺序逐本 library:import
       → 汇总 { imported, failed } + ignored → 结果反馈
       → 有成功则 invalidate(qk.library) 刷新书库
  → drop on 暗背景: 取消，归零，不导入
```

## 边界

- **作用域**：仅书库（LibraryView 卸载即无监听）。设置弹层打开时其 modal 盖住书库，drop 落不到根 → 自然不触发。
- **幂等**：现有 import 以 epub 自然键为主键，重复拖入自动幂等（更新/no-op），无需额外处理。
- **拖拽中途切到 reader**：LibraryView 卸载，监听消失，无悬挂状态。
- **拖入文件夹**：无 `.epub` 后缀 → 归 `ignored`，提示忽略。

## 测试策略

- `epub-drop.test.ts`（headless vitest）：
  - `isFilesDrag(["Files"]) === true`；`isFilesDrag(["text/plain"]) === false`。
  - `pickEpubFiles`：全 epub / 全非 epub / 混合 / `.EPUB` 大写 / 文件夹（无后缀）/ 空数组 → 验证 `epubs`/`ignored` 分组与顺序保留。
- hook / DropOverlay / LibraryView：DOM/React，依项目惯例不单测；靠 `pnpm start` 手验：拖入单本、多本、混入 pdf（验忽略提示）、拖到卡片外（验取消）、失败用例（验错误透传）。
- `pnpm typecheck`：验 `pathForFile` 并入 `RendererApi` 的类型契约。

## 非目标（YAGNI）

- 不做全 App 通用的 `FileDropZone`（仅书库需要）。
- 不在阅读器内支持拖拽导入。
- 不做导入进度条/队列管理（顺序循环 + 简单计数足够）。
