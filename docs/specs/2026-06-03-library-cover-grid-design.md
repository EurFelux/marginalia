# 书库封面墙（Apple Books 风）设计

> **日期**：2026-06-03
> **分支**：`feat/library-cover-grid`（基于含 #9 P1/P2/P4 的 main）
> **状态**：设计定稿，待 plan
> **关联 backlog**：「书库样式改善 + 书封面」（用户 2026-06-03 指定）

## 背景

封面数据**已经在库里**：`epub-parser` 的 `parse.ts`（EPUB3 `cover-image` 属性 / EPUB2 `meta[name=cover]` 兜底）提取封面字节，`importBook`（`repository.ts:38`）存进 `books.cover` blob。但渲染层**完全没用它**——`LibraryView` 现在把每本书渲染成「`BookOpen` 占位图标 + 标题 + 作者」的横向行卡。本功能把已存封面显示出来，并把书库改成 **Apple Books 风的纯封面墙**。

## 设计决策（已与用户确认）

- **DD-1 视觉**：**纯封面墙**——大封面网格，封面下**不挂任何文字**。有封面 → 显示封面图；**无封面 → 用「截断书名 + 作者」生成一个封面 tile**（**按 bookId 确定性派生的渐变配色**——同书恒定、视觉多彩随机；衬线大字书名 `line-clamp` + 小字作者）。hover 微抬。
- **DD-2 封面传输**：**自定义协议 `cover://`**——主进程 `protocol.handle` 读 `books.cover` blob 返回图片 Response；渲染层 `<img src="cover://...">`。浏览器自带懒加载/缓存、无 blob 生命周期，最适合封面墙（同屏多张）。
- **DD-3 hasCover 标志**：`library:list` 的 DTO 加 `hasCover: boolean`，渲染层据此决定「显封面」还是「兜底 tile」（避免先渲染破图再 onError 切换的闪烁）。
- **DD-4 顺手修浪费**：现 `listBooks` 用 `select().from(books).all()` ——**把所有封面 blob 全载进内存**（list 每次都白载、随即被 `toDto` 丢弃）。改为只选所需列 + 派生 `hasCover`，**不再载 blob**；封面字节只在 `<img>` 请求 `cover://` 时按需读。

## 架构 / 数据流

```
导入时已存 books.cover(blob)
   │
   ├─（主进程）cover:// 协议  protocol.handle → 读 books.cover → 图片 Response（按需、可缓存）
   │                                   ▲
渲染层 <img src="cover://b/<id>"> ──────┘   （hasCover=true 的书）
   │
library:list → {id,title,author,hasCover}（不含 blob）
   └─ hasCover=false → 渲染兜底 tile（书名+作者）
```

## §1 · `cover://` 协议（新 `src/main/library/cover-protocol.ts`）

**URL 格式**：`cover://b/<encodeURIComponent(bookId)>`。

- 固定 host `b`，bookId **百分号编码**放 path——bookId 可能是 ePub uid（`urn:uuid:…` / `http://…`，含 `:`/`/`，不能直接当 URL host；与 #9 文件名安全同源问题）。

**scheme 注册**（`app.ready` 前，模块顶层）：

```ts
protocol.registerSchemesAsPrivileged([
  { scheme: "cover", privileges: { standard: true, secure: true, supportFetchAPI: true } },
]);
```

导出 `registerCoverProtocolScheme()`，在 `main.ts` 顶层（`app.on("ready")` 之前）调用。

**handler 注册**（`app.ready` 内、`initDb()` 之后，因 handler 需 `getDb()`）：

```ts
protocol.handle("cover", (request) => {
  const id = decodeURIComponent(new URL(request.url).pathname.replace(/^\/+/, ""));
  const hit = coverResponseFor(getDb(), id);
  return hit
    ? new Response(hit.bytes, { headers: { "content-type": hit.contentType } })
    : new Response(null, { status: 404 });
});
```

导出 `registerCoverProtocol()`，在 `main.ts` 的 ready 回调里调用。

**纯函数（注入 db，headless 可测）**：

```ts
// (db, bookId) → 命中封面字节 + content-type；无书 / 无封面 → null
export function coverResponseFor(
  db: DB,
  bookId: string,
): { bytes: Uint8Array; contentType: string } | null {
  const row = db.select({ cover: books.cover }).from(books).where(eq(books.id, bookId)).get();
  if (!row?.cover) return null;
  const bytes = new Uint8Array(row.cover);
  return { bytes, contentType: sniffImageType(bytes) };
}

// 按 magic bytes 判图片类型（epub-parser 只给字节、不给 MIME，故读时嗅探）
export function sniffImageType(bytes: Uint8Array): string {
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes.length >= 8 &&
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  )
    return "image/png";
  if (bytes.length >= 6 && bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46)
    return "image/gif"; // GIF8
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp"; // RIFF....WEBP
  return "application/octet-stream";
}
```

`main.ts` 仅做协议注册胶水（接触 Electron）；`coverResponseFor`/`sniffImageType` 无头可测。

## §2 · `listBooks` 加 `hasCover`、不再载 blob

`repository.ts` 的 `listBooks` 改为只选所需列 + 派生 `hasCover`（不取 `cover` blob）：

```ts
export function listBooks(db: DB): BookListItem[] {
  return db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      addedAt: books.addedAt,
      hasCover: sql<boolean>`${books.cover} is not null`,
    })
    .from(books)
    .all();
}
```

（`hasCover` 经 `sql` 返回 0/1，drizzle 映射；DTO 侧规范成 boolean。）

`BookSummaryDto`（`shared/library.ts`）：**去 `path`**（#9 P3 同步在做）+ **加 `hasCover: boolean`** → `{ id, title, author, hasCover }`。`library-handlers.ts` 的 `toDto` 相应调整（不再有 `path`，透传 `hasCover`）。

## §3 · 渲染层：纯封面墙

**新组件 `src/renderer/library/BookCover.tsx`**（与 reader 的 `BookCard` 区分）：

- `hasCover` → `<img src={`cover://b/${encodeURIComponent(id)}`} alt={title ?? ""} loading="lazy" className="...aspect-[2/3] object-cover rounded-md shadow-..." />`。
- 否则**兜底 tile**：`div`（`aspect-[2/3]` + `rounded-md` + shadow + 渐变底 `bg-gradient-to-br ${coverGradientClass(id)}`），内含书名（`font-serif`、`line-clamp-4`、白字）+ 作者（`text-xs` 半透明截断）。`aria-label`=书名+作者。
- **配色 helper `src/renderer/library/cover-palette.ts`**（纯函数、可测，类比 `epub-drop.ts`）：精选一组 Tailwind 渐变类对（如 `from-violet-500 to-violet-800`、`from-rose-600 to-rose-900` 等 N≈8 个，**字面量写死**供 Tailwind JIT 扫描生成），`coverGradientClass(bookId)` 用确定性字符串 hash 取 `PALETTE[hash % N]` → 同书恒定、跨书多彩随机。
- 整个封面包在开书的 `<button>`，hover `-translate-y-1` + 投影加深（Tailwind 工具类，遵循「优先工具类」规范；动画值用类）。

**`LibraryView`**：

- 网格 `grid grid-cols-[repeat(auto-fill,minmax(150px,1fr))] gap-...`，每项渲染 `<BookCover>`。**封面下无文字**。
- 导入/拖拽/空态/header/toast 逻辑**不动**，仅替换列表项渲染（现第 137–156 行的 `<ul>` 行卡）。

## §4 · CSP

全仓**当前无 CSP 声明**（`index.html` 无 meta、src 无 header）→ `cover://`（已注册为 privileged/secure）开箱可用，**本功能无需改 CSP**。备注：将来若引入 CSP，`img-src` 须含 `cover:`。

## §5 · 测试

- **主进程（headless 单测）**：
  - `sniffImageType`：jpeg/png/gif/webp magic bytes + 未知→octet-stream。
  - `coverResponseFor`：有封面命中（含 content-type）/ 无封面书→null / 无此书→null。
  - `listBooks`：`hasCover` 派生正确（有/无封面）；返回**不含** `cover` 字段（不载 blob）。
- **渲染层纯函数（headless 单测，类比 `epub-drop.test.ts`）**：`coverGradientClass` 确定性——同 id 恒返同类、跨 id 覆盖多个调色板项。
- **渲染层组件**：`BookCover`（有封面 `<img>` / 无封面兜底 tile / 长书名截断 / a11y label）走**手测**——vitest 跑 Node/Electron 无 DOM，RA 组件素来手验。`pnpm start` 真书目验封面墙。

## §6 · 与 #9 P3 协调（并行进行中）

| 文件                  | 本功能                               | P3                                          | 合并                          |
| --------------------- | ------------------------------------ | ------------------------------------------- | ----------------------------- |
| `repository.ts`       | 改 `listBooks`（+hasCover、去 blob） | 改 `importBook`/加 `deleteBook`（不同函数） | trivial                       |
| `shared/library.ts`   | `BookSummaryDto` **+hasCover**       | `BookSummaryDto` **−path**                  | additive，二者合并保留 both   |
| `library-handlers.ts` | `toDto` 透传 hasCover                | `toDto` 去 path + import 复制文件           | 同 `toDto`，小冲突、保留 both |
| `main.ts`             | 加协议注册                           | 不碰                                        | 无                            |

P4 已合（碰 `forge.config.ts`/`instance.ts`），与本功能无关。本功能**不碰** `book-files.ts`/`schema.ts`/`shared/ipc.ts`/`preload.ts`/FK，避开 P3 主战场。

## 设计决策记录（速查）

- **DD-1**：纯封面墙、无文字标注；无封面 → 截断书名+作者生成 tile。
- **DD-2**：`cover://b/<encodeURIComponent(id)>` 自定义协议（privileged/secure），主进程读 blob 返回图片。
- **DD-3**：`hasCover` 标志驱动「封面 vs 兜底」，免破图闪烁。
- **DD-4**：`listBooks` 去 blob 载入 + 派生 hasCover（修内存浪费，封面按需懒读）。
- **DD-5**：content-type 读时按 magic bytes 嗅探（epub-parser 不给 MIME）。
- **DD-6**：兜底 tile 配色 = `coverGradientClass(bookId)` 从精选 Tailwind 渐变调色板按确定性 hash 取（同书恒定、跨书多彩随机）。
