# 继续阅读书架 + 手动拖拽排序 + reader 进度显示设计

日期：2026-06-07
状态：已与用户对齐（2026-06-07 brainstorming，含可视化伴侣选型），待实现
关联：GitHub issue #48（含两轮 pre-implementation analysis 评论，本设计基于产品决策修订版）；分支 `feat/library-shelf-reorder`

## 1. 背景与动机

书库网格目前按隐式 rowid（≈ 导入序）排列，无法重排；读到一半的书与从未打开的书在视觉上无任何区分，「接着读」要靠记忆找书。产品决策（2026-06-07）：

- 书库网格上方加「**继续阅读**」书架——展示最近读过的书，强调续读动作；
- 主网格支持**手动拖拽排序**（唯一排序方式，字段排序明确出范围）；
- 顺带补上 reader 内一直缺失的**阅读进度显示**（与书架的 percent 同源）。

## 2. 决策摘要

| 决策点          | 结论                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 书架形态        | **「继续阅读」信息卡**（Apple Books 风）：封面 + 书名 + 作者 + 进度条 + 百分比；非紧凑条带、非同尺寸网格行（可视化伴侣三选一定案）                                         |
| 书架容量        | **最多 3 本，单行**——聚焦最近的 2-3 本，不做第二个书库                                                                                                                     |
| 空状态          | **整个隐藏**：无阅读记录就不渲染 shelf，网格顶到最上；读过第一本后自然浮现                                                                                                 |
| 章节名          | **不显示**（用户裁剪）：卡片只要 percent，`chapterTitle` 不入库                                                                                                            |
| 拖拽库          | **dnd-kit**（`@dnd-kit/core` + `@dnd-kit/sortable`，项目首个拖拽依赖）：pointer events 与文件拖拽导入的原生 drag 事件天然隔离，sortable 网格预设现成                       |
| percent 存储    | **`progress.percent`，real 可空，0–1 浮点**，**DB `CHECK` 约束范围**（贴合枚举列 CHECK 惯例）；reader 保存进度时顺手写入（「展示快照」思路）                               |
| lastReadAt      | **不加列**：`progress.updatedAt` 就是最近阅读时间（一书一行），shelf 用 `JOIN progress` 小查询——issue 评论建议的 `books.lastReadAt` 是旧方向（全列表字段排序）的产物，弃用 |
| locator 黑盒    | **保持**：主进程不解析 locator；percent 由正在渲染该页的 reader 计算后上送                                                                                                 |
| reader 进度位置 | **header 面包屑后缀**（`书名 · 章节 · 38%`；PDF 为 `书名 · 章节 · 12 / 304 · 4%`）；header 收起时不显示，接受（可视化伴侣三选一定案）                                      |
| 新书位置        | **排最前**（`position = MIN(position) - 1`）：刚导入大概率就是要读的；其余书相对顺序不动                                                                                   |
| position 约束   | **不加唯一约束**：reorder 与并发导入竞争可能产生重复 position，以 rowid 平断，下次拖拽全量重写自愈                                                                         |

## 3. 数据层（迁移）

一次迁移，两张表加列：

- `progress.percent`：`real` 可空 + `CHECK (percent IS NULL OR (percent BETWEEN 0 AND 1))`。老进度行为 null，读一次书自然回填。
- `books.position`：`integer NOT NULL DEFAULT 0`，**不做数据回填**（实现阶段定案）：`listBooks` 用 `ORDER BY position ASC, added_at ASC`——既有书 position 全 0 时按 added_at（≈导入序）平断，与 ROW_NUMBER 回填等效且免手编迁移文件；首次拖拽全量重写后 position 唯一。

**drizzle-kit 产出预案**：drizzle 的 `check()` 是表级约束，对已有表加带 CHECK 的列可能生成**表重建**迁移而非 `ADD COLUMN`。`runMigrations` 已有事务外切 FK 的基建（见 db-lifecycle 坑记录），且无表反向引用 `progress`，重建安全；以 `pnpm db:generate` 实际产出为准，迁移后跑全量 vitest 验证。

**批量导入顺序**：逐本 `MIN(position) - 1` 会让同批次内顺序倒置（后导的更靠前）。接受此 luxury problem，不为它设计批次协议。

## 4. IPC 契约（`src/shared`）

- `saveProgressInput` 加 `percent: z.number().min(0).max(1).nullish()`。
- 新通道 `library:recentlyRead`：入参无；出参 `RecentlyReadDto[]`：

  ```ts
  interface RecentlyReadDto extends BookSummaryDto {
    percent: number | null; // 0–1；老数据 null → 卡片不渲染进度行
    lastReadAt: number; // = progress.updatedAt
  }
  ```

  最多 3 条（主进程常量 `RECENT_SHELF_LIMIT = 3`）。

- 新通道 `library:reorder`：入参 `{ orderedIds: string[] }`（渲染层发**全量**当前顺序），出参 void。
- `library:list` 契约不变，实现加 `ORDER BY position`。

## 5. 主进程

纯函数（`:memory:` vitest 直测），胶水层照 IPC 脊柱模式注入 `getDb()`：

- `repository.ts`
  - `listBooks`：加 `.orderBy(books.position)`。
  - `listRecentlyRead(db, limit)`：`books INNER JOIN progress ON progress.bookId = books.id`，投影 BookSummaryDto 字段 + `progress.percent` + `progress.updatedAt as lastReadAt`，`ORDER BY progress.updatedAt DESC LIMIT 3`。未读过的书（无 progress 行）天然不出现。
  - `reorderBooks(db, orderedIds)`：事务内逐 id `UPDATE books SET position = <index>`。
  - 导入路径：插入时 `position = MIN(position) - 1`（空库为 0）。
- `progress.ts`：`saveProgress(db, bookId, locator, percent?)`——upsert 的 insert/update 两路径均带 percent。
- handlers + `preload.ts`：注册 `library:recentlyRead`、`library:reorder`，暴露 `window.api.library.recentlyRead()` / `.reorder()`。

## 6. 渲染层

### 6.1 RecentlyReadShelf（新组件）

`src/renderer/library/RecentlyReadShelf.tsx`，置于 LibraryView header 与网格之间：

- `useQuery(qk.recentlyRead)`，**`staleTime: 0`**——读完书返回书库时 LibraryView 重新挂载即 refetch，保证新鲜（书库切 reader 是条件渲染卸载/重挂）。
- 空数组 → `return null`（整个隐藏）；查询失败 → 同样隐藏 + `log.warn`（优雅吞错必须留 warn）。
- 卡片：封面（`cover://b/<id>` + 无封面渐变兜底——从 `BookCover` 抽出 `CoverImage` 小组件共用）、书名、作者、进度条 + `Math.round(percent * 100)%`；`percent === null` 不渲染进度行。
- 点击卡片 → `openBook(id)`。shelf 卡**不参与拖拽**——shelf 是视图不是分区，同一本书出现在 shelf 与网格属预期（issue 明示，冒烟目检确认）。

### 6.2 主网格拖拽排序（dnd-kit）

- 网格包 `DndContext`（PointerSensor，**`activationConstraint: { distance: 8 }`**——位移 8px 才激活拖拽，普通点击仍走 `onOpen`）+ `SortableContext`（`rectSortingStrategy`，适配 `auto-fill` 网格）。
- 每张卡包 `useSortable`；transform/transition 是运行时计算值，走内联 style（符合样式规范的例外条款）。
- `onDragEnd`：`arrayMove` 算新序 → **乐观更新** `qk.library` 缓存 → 发 `library:reorder`；失败 invalidate 恢复真序 + toast 透传真实错误（honest-error）。
- 拖拽中以 `DragOverlay` 渲染浮起卡。
- **手势隔离**（issue 点名坑）：dnd-kit 走 pointer events，文件导入 drop 走原生 drag 事件挂 LibraryView 根，两通道不相交；冒烟须含「中止卡片拖拽后再拖文件入窗」。

### 6.3 reader 进度显示（与 percent 同源）

- `ReadingContext` 类型加 `percent: number | null`：
  - epub：`(index + scrollRatio) / book.count`——spine 比例近似（`textLengths` 惰性填充，字符加权不可行）；
  - PDF：`page / pageCount`，精确。
- 两个 reader 在现有 `setReadingContext` 调用点顺手计算；**同一个值**双消费：
  1. ReaderView header 面包屑后缀（epub：`· 38%`；PDF：`· 12 / 304 · 4%`）；
  2. 防抖 `progress:save` 落库（shelf 数据源）。
- percent 计算抽纯函数（`epubPercent` / `pdfPercent`，clamp 0–1），vitest 直测。

## 7. 错误处理

| 故障点                  | 行为                                                  |
| ----------------------- | ----------------------------------------------------- |
| `recentlyRead` 查询失败 | shelf 整个隐藏 + renderer `log.warn`                  |
| `reorder` IPC 失败      | invalidate `qk.library` 恢复真序 + toast 透传真实错误 |
| `progress:save` 失败    | 沿用现有 `log.warn("save progress failed")` 路径      |
| 老进度行 percent null   | shelf 卡降级不显示进度行；reader 首次滚动保存即回填   |

## 8. 测试

- **主进程 vitest**：`listRecentlyRead`（排序 / limit / 未读不出现 / percent 透传）、`reorderBooks`（全量重排、事务原子性）、`listBooks` 按 position、导入 `MIN - 1`（含空库）、`saveProgress` percent 双路径 upsert、percent CHECK 越界拒写。
- **渲染层 vitest**：`epubPercent` / `pdfPercent` 边界 clamp。
- **CDP 冒烟**（交付前，playwright-core connectOverCDP）：
  1. 拖一张卡到新位置 → 重启后顺序保持；
  2. 中止卡片拖拽后再拖文件入窗（手势隔离）；
  3. shelf 三卡显示、点击进书、同书同时出现在 shelf 与网格（目检）；
  4. 面包屑百分比随滚动变化。

## 9. 范围外（明确不做）

- 字段排序（按标题/日期下拉）——产品决策明确砍掉；
- `chapterTitle` 入库——用户裁剪；
- `books.lastReadAt` 反规范化列——被 `JOIN progress` 取代；
- shelf 容量/形态偏好设置——定值 3 本信息卡，无 preference key（绕开 preferences 三处同步坑）。
