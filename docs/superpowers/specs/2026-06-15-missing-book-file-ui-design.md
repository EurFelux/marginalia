# 缺失书文件的删除/重连 UI 设计（#27）

> Status: 设计已认可，待写实现计划
> Source: GitHub issue #27（area:library, enhancement, P1）
> Date: 2026-06-15

## 背景与问题

书籍导入时，app 会把原始字节复制一份到自有位置 `<userData>/books/<sha256(bookId)>.<format>`（见 `writeBookFile`）。阅读时从这份**自有副本**读字节，而非用户的原始文件。

当这份副本缺失（被外部删除、userData 迁移不全、磁盘清理等），主进程 `readBookFile` 抛 `BookFileMissingError`。但渲染层缺少对应 UI：

- `EpubReader.tsx:366` / `PdfReader.tsx:332` 各自有一个 `bytesError` 分支，但都只显示一句死文案（「无法读取此书的文件」），**没有任何操作出口**；
- 且不区分「文件缺失」与其他 IO 错误，用户卡死——既不能恢复，也得不到指引。

本设计补齐：打开缺失书时，给用户两条出路——**重连**（选回原文件，无缝恢复）或**删除**（清理这本坏书）。

## 目标 / 非目标

**目标**

- 打开书时若文件缺失，被动拦截并呈现可操作的「文件缺失」面板（重连 / 删除 / 返回书库）。
- 重连：用户选回**内容一致**的原文件即可无缝恢复阅读，进度 / 标注 / 对话 / 章节索引全部保留。
- epub 与 pdf 均覆盖，复用同一套面板与判别逻辑。

**非目标（明确排除，避免范围蔓延）**

- 不做书库列表的主动文件存在性探测 / 缺失标记（用户选了「仅打开书被动拦截」）。
- 不做「替换为不同文件」的迁移式重连（books.id = 内容哈希，跨文件迁移进度/CFI 不可靠，YAGNI）。
- 不把全部 IPC 通道改为结构化错误约定——那是 **#24 Structured error reason categories**（P2）的范畴。本设计只动 `readBookBytes` 一个通道。
- 不处理 AI 聊天路径（`send-deps` 内部 `readBookFile`）的文件缺失——可作后续。

## 关键约束与决策依据

### A. `books.id` 恒为 `sha256(bytes)`（epub 与 pdf 一致）

`repository.ts:79-81` 明确：epub 的 `dc:identifier` 现实中不唯一（z-library 等转换源会给不同书盖同一 boilerplate uid），故弃用，**统一用文件内容哈希**作主键。物理路径由 `bookId + format` 确定性派生。

→ **重连校验极简单**：读选中文件字节，算 `sha256(bytes)`，等于原 `bookId` 即「同一文件」，直接 `writeBookFile` 写回原派生路径。无需复用解析逻辑。

### B. Electron IPC 异常透传会丢失 `error.name` 与自定义字段（已实测）

2026-06-15 用真实 Electron 41 IPC 冒烟验证：主进程 `ipcMain.handle` 抛自定义错误，渲染层 `ipcRenderer.invoke` 的 reject error 为：

```json
{
  "name": "Error", // 原 name "BookFileMissingError" 丢失，重置为 "Error"
  "ownKeys": [],
  "bookId": null, // 自定义 own property 全部丢失
  "message": "Error invoking remote method 'test:throw': BookFileMissingError: book file missing for book abc123"
}
```

→ 渲染层**不能**靠 `err.name === "..."`、`instanceof`、自定义字段判别错误类型。原始 name 仅以子串形式残留在 message 里——靠字符串匹配判别脆弱且不优雅。

→ **决策：把「文件缺失」改为结构化返回值，绕开异常通道。** `readBookBytes` 不再以异常表达「文件缺失」，而是 safe-return 一个判别联合，错误信息作为普通数据走结构化克隆完整传回，渲染层类型安全判别。

## 设计

### 1. `readBookBytes` 改 safe-return 契约（错误判别）

**契约**（`src/shared/library.ts` 新增类型，`src/shared/ipc.ts` 改 output 载体）：

```ts
export type ReadBookBytesResult =
  | { ok: true; data: Uint8Array }
  | { ok: false; error: { reason: "missing" } };
```

`out<O>()` 仅为类型载体不做运行时校验（`ipc.ts:116`），故改 output 即改类型 + handler 返回结构 + 渲染层解包，无运行时 schema 改动。

**handler 边界转换**（`library-handlers.ts`）：

```text
try   readBookFile(...) → { ok: true, data }
catch BookFileMissingError → { ok: false, error: { reason: "missing" } }
catch 其他意外错误 → rethrow（走 registry catch-all 自动落盘 + 渲染层 query.isError 通用错误态）
```

- 仅「文件缺失」走 Result；意外错误仍 throw（你拍板：异常归异常，复用现有基础设施，不吞 registry 落盘）。
- 主进程内部 `readBookFile` **保持抛 `BookFileMissingError`**（内部异常不经 IPC、不丢信息）；只在 `readBookBytes` 这一处 handler 边界 catch 转 Result。
- `reason` 目前只有 `"missing"` 一个值，预留为字面量联合，未来需要别的预期失败再扩——不预造通用 `IpcError` 框架（YAGNI）。

**渲染层解包**（2 个调用点）：

- `epub-session.tsx`：`bytes` query 解包 Result。Provider 暴露两个信号取代现有 `bytesError: bytes.isError` 布尔：
  - `bytesMissing`：`bytes.data?.ok === false && bytes.data.error.reason === "missing"`
  - `bytesError`：`bytes.isError`（真意外异常）
- `PdfReader.tsx`：同样解包 `bytes` query。

### 2. 重连：新增 `library:relink` IPC

**契约**：`def("library:relink", "invoke", bookIdInput, out<RelinkResult>())`，复用 `bookIdInput`（`{ bookId }`）。

```ts
export type RelinkResult = { status: "ok" | "canceled" | "mismatch" };
```

`canceled`（用户取消选择）与 `mismatch`（选错文件）都是预期内情形，用返回值表达而非异常——避免误报错误态、语气负面。

**handler 胶水层**（`library-handlers.ts`，碰 Electron `dialog` 的胶水）：

1. `dialog.showOpenDialog`（filters 同 `pick-book`：epub/pdf）；用户取消 → `{ status: "canceled" }`。
2. 读选中文件字节，调纯函数校验写回。

**纯函数**（放 `book-files.ts`，与 `writeBookFile`/`readBookFile` 同源、可单测、注入 booksDir）：

```ts
relinkBookFile(booksDir, bookId, format, bytes) → "ok" | "mismatch"
  sha256(bytes) !== bookId → "mismatch"        // 选错文件，绝不污染库
  否则 writeBookFile(booksDir, bookId, format, bytes) → "ok"
```

- `format` 由 handler 从 `getBook(db, bookId).format` 取并传入——纯函数不查 db、不依赖 `detectFormat`，**避免 `book-files.ts ↔ repository.ts` 循环依赖**（repository 已 import book-files 的 `deleteBookFile`）。
- `sha256` 匹配即保证字节完全一致，format 与原书必然一致，无需重新嗅探。
- 校验不匹配时**不写任何东西**，库不受污染（区别于裸调 import 会建出一本新书）。

**重连成功后**：渲染层 `qc.invalidateQueries(qk.bookBytes(bookId))`，reader 自动重新加载字节并正常进入阅读。因为 `bookId` 未变、DB 行始终都在，**进度 / 标注 / 对话 / 章节索引无缝保留**——重连只是补回了那份缺失的字节副本。

### 3. 缺失面板 UI：共享 `BookFileMissingPanel`

新组件 `src/renderer/reader/BookFileMissingPanel.tsx`，props `{ bookId }`。epub/pdf 的「文件缺失」分支都渲染它（替代各自重复的死文案）：

- empty-state 居中布局（Tailwind 工具类）：图标 + 标题「这本书的文件不见了」+ 说明「文件可能被移动或删除。重新选择原文件可恢复阅读（含进度与标注），或从书库删除这本书。」
- 主操作「重新选择文件」→ 调 `window.api.library.relink({ bookId })`，按返回 `status`：
  - `ok` → `toast.success`（已重新连接）+ invalidate `qk.bookBytes(bookId)`；
  - `mismatch` → 面板内联提示「这不是同一个文件（内容不一致）」（非破坏性，留在面板可重试）；
  - `canceled` → 无动作。
- 次操作「从书库删除」（destructive）→ 复用现有 `AlertDialog` 二次确认 → `window.api.library.delete({ bookId })` → 成功 toast + `backToLibrary()`。
- 「返回书库」次要链接 → `backToLibrary()`。
- 文案全走 `t()`，新增 i18n key（`reader.missingFile.*`）；改文案后跑 `pnpm i18n:extract`。

**分流**（EpubReader / PdfReader 的渲染分支）：

```text
bytesMissing → <BookFileMissingPanel bookId={bookId} />
bytesError（真意外）→ 保留现有通用 ReaderError（重连解决不了非缺失的问题，不显示重连）
```

### 4. 删除：完全复用现有能力

`library:delete` 已完善（`repository.ts:334` `deleteBook`）：先删 DB 行（FK `ON DELETE CASCADE` 自动清 chapters/progress/annotations/conversations/memories），再 best-effort 删文件副本（缺失无害、幂等）。本设计**不新增任何删除逻辑**，面板里直接调它 + 复用 `AlertDialog` 确认模式（参考 `BookCover.tsx:106` 既有用法）。

## 数据流

```text
打开书 → reader 加载 bytes（readBookBytes）
  ├─ { ok: true, data }  → 正常渲染
  ├─ { ok: false, missing } → BookFileMissingPanel
  │     ├─ 重连 → pick file → relink(sha256 校验)
  │     │     ├─ ok      → writeBookFile 写回 → invalidate bookBytes → 重新加载，无缝恢复
  │     │     ├─ mismatch→ 面板内联提示，可重试
  │     │     └─ canceled→ 无动作
  │     └─ 删除 → AlertDialog 确认 → library:delete（级联+删文件）→ 回书库
  └─ throw（意外 IO 错误）→ query.isError → 通用 ReaderError
```

## 错误处理与日志

- 意外错误仍 throw → `registry.ts` catch-all 自动 `log.error` 落盘，handler 内不重复记录。
- 重连 `mismatch` / `canceled` 是预期返回值、非错误，不落 error 日志；重连 `ok` 可留一条 `log.info`（关键锚点：文件已重连）。
- 渲染层一律用 sonner toast / 面板内联，不用 OS 弹窗（项目既有约定）。

## 测试策略

- 纯函数 `relinkBookFile`（vitest，临时 booksDir）：匹配 → 写回正确派生路径且字节一致；不匹配 → 返回 mismatch 且不落任何文件。
- `readBookBytes` handler 的 Result 转换（headless binding 测试）：文件缺失 → `{ ok: false, missing }`；正常 → `{ ok: true, data }`；意外错误 → rethrow。
- 渲染层面板交互可在原型/手动冒烟覆盖（删除已有回归，重连为新路径）。

## 文件改动清单（预估）

**主进程 / shared**

- `src/shared/library.ts`：新增 `ReadBookBytesResult`、`RelinkResult` 类型。
- `src/shared/ipc.ts`：`libraryReadBookBytes` output 改 `ReadBookBytesResult`；新增 `libraryRelink` 契约。
- `src/preload-api.ts`：暴露 `library.relink`。
- `src/main/library/book-files.ts`：新增纯函数 `relinkBookFile(booksDir, bookId, format, bytes)`。
- `src/main/ipc/library-handlers.ts`：`readBookBytes` handler 改 safe-return；新增 `relink` handler（弹 dialog + `getBook` 取 format + 纯函数）。

**渲染层**

- `src/renderer/reader/epub-session.tsx`：解包 Result，暴露 `bytesMissing` / `bytesError`。
- `src/renderer/reader/EpubReader.tsx`、`PdfReader.tsx`：分流到面板 vs 通用错误态。
- `src/renderer/reader/BookFileMissingPanel.tsx`：新组件。
- i18n locales：新增 `reader.missingFile.*` key。

## 范围与未来工作

- **#24**：若日后要把更多 IPC 通道结构化错误化，可以本通道的 safe-return 为范本推广——但本 issue 不做。
- AI 聊天路径文件缺失处理、书库主动缺失标记：均明确排除，作后续候选。
