# 记忆去除来源书绑定（drop `memories.sourceBookId`）

- 日期：2026-06-16
- 状态：待实现
- 关联：修订 [`2026-06-10-ai-global-memory-soul-design`](./2026-06-10-ai-global-memory-soul-design.md)（§1 阶段二铺路、§2.1 `sourceBookId` 列、§6 删书 SET NULL 行为）

## 1. 背景与决策

当前 `memories` 表有一列 `sourceBookId text → books.id (ON DELETE SET NULL)`，spec 2026-06-10 把它定位为「在哪记下的」溯源标签（非归属），主进程从会话 `bookId` 自动回填。实际消费点只有两处：

- `MemorySettings.tsx` 在记忆列表展示 `· 来源书名`；
- `repository.ts` 的 `listMemories` 通过 `leftJoin(books)` 取**实时**书名。

没有任何功能逻辑按 `sourceBookId` 查询/过滤；阶段二「跨书联想」尚未实现。

**问题**：FK + `ON DELETE SET NULL` + 实时 join，意味着删书会**永久抹掉**这条溯源（id 置空 → join 不到书名），与 spec 自己立的「记忆是全局事实、不随书消失」相矛盾——事实本体虽留，溯源却随书消亡。该绑定为「跟项目惯例顺手而立」，非功能刚需。

**决策**：**彻底删除 `sourceBookId` 列**（连同 FK 与索引），不留任何结构化来源列（也不引入书名快照列）。一条记忆是否要记录「来自哪本书」，是**记忆自身内容的决策**——AI 觉得相关时自然写进 `body`/`description` 文本（如「（记于《X》）」），DB 层不做任何结构性约束。`memories` 与 `books` 生命周期彻底解耦。

理念落点：与「派生状态不另立真相」「YAGNI」一致——溯源不是查询维度，就不该占一列、不该牵一条 FK。

## 2. Schema 改动

`src/main/db/schema.ts` 的 `memories` 表：

- 删除 `sourceBookId: text("source_book_id").references(() => books.id, { onDelete: "set null" })`；
- 删除 `index("memories_source_book_id_idx").on(t.sourceBookId)`（表定义里 `(t) => [...]` 整段随之清空）。

`memory_links`、`memories` 其余列（slug/title/description/body/时间戳）不动。

### 迁移

- 跑 `pnpm db:generate` 生成表重建迁移（drizzle-orm 1.0-rc 新格式：独立子目录 `<ts>_<name>/`，含 `migration.sql` + `snapshot.json`）。删列在 SQLite 下走「建新表→拷数据→换名」重建。
- 表重建 + FK 事务坑：`runMigrations` 已在事务外切 `foreign_keys`，无需额外处理。
- 现有库里 `sourceBookId` 数据直接丢弃（本就是可丢溯源，符合决策）。
- 验证以全量 `pnpm test` 为准（非仅 typecheck），确保迁移在既有数据上不炸 FK/cascade。

## 3. 消费点改动（去结构化来源）

| 文件                                       | 改动                                                                                                                                                                                                                                    |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/shared/memory.ts`                     | `MemoryDto` 删 `sourceBookId` / `sourceBookTitle` 两字段；更新接口注释（去「含来源书名投影」）                                                                                                                                          |
| `src/main/memory/repository.ts`            | `CreateMemoryInput` 删 `sourceBookId`；`listMemories` 删两个 select 字段、删 `leftJoin(books)`、删收尾 `.map(sourceBookTitle ?? null)`；删不再使用的 `books` import                                                                     |
| `src/main/ai/memory-tools.ts`              | `MemoryToolsDeps` 删 `bookId` 字段及注释；`createMemoryTools` 去解构 `bookId`；`saveMemory` 改 `createMemory(db, { slug, title, description, body })`                                                                                   |
| `src/main/ai/memory-consolidation.ts`      | `applyMemoryOps` 删 `opts: { sourceBookId }` 形参，`save` 分支改 `createMemory(db, { slug, title, description, body })`；`maybeConsolidateMemory` 删 `bookId` 形参（其唯一用途即喂 sourceBookId）；调用 `applyMemoryOps` 去掉 opts 实参 |
| `src/main/ai/stream-assistant.ts`          | 第 61 行 `createMemoryTools({ db })`（去 bookId）；第 173 行 `maybeConsolidateMemory(..., conversationId)`（去 bookId 实参）。`bookId` 变量本身保留（contextTools 等仍用）                                                              |
| `src/renderer/settings/MemorySettings.tsx` | 删展示态里 `{mem.sourceBookTitle && (<span>· …</span>)}` 整块（约 211–215 行）                                                                                                                                                          |

> 注：`stream-assistant.ts` 的 `bookId` 由 contextTools（74 行）与其它分支继续使用，仅断开它流向记忆工具/整理链路这条线。

## 4. 测试改动

机械清理 + 删一个已失语义的用例：

- `repository.test.ts`：所有 `createMemory(...)` 去 `sourceBookId`；**删除**「keeps memory on book deletion (sourceBookId SET NULL)」用例（FK 与 SET NULL 行为已不存在，该断言失去意义）。
- `agent-context.test.ts` / `base-prompt.test.ts`：`createMemory(...)` 去 `sourceBookId`。
- `memory-tools.test.ts`：`createMemoryTools({ db })`（去 bookId）；「saveMemory fills sourceBookId from deps」用例改写为只断言「保存成功并回 slug」；其余 `createMemory` 去 `sourceBookId`。
- `memory-consolidation.test.ts`：`applyMemoryOps(...)` 去 `{ sourceBookId }` 实参；`maybeConsolidateMemory(...)` 去 `bookId` 实参；「saves a new memory and fills sourceBookId」用例改写为只断言保存成功（去 seed-book 注释与 `sourceBookId` 断言）；`MemoryDto` 夹具去 `sourceBookId` / `sourceBookTitle`。

实现按 TDD：先改/删测试到「描述新契约」，红→改实现→绿。

## 5. 范围之外（YAGNI）

- 不引入书名快照列、不做「有书 join / 无书回退快照」的折中——决策是**完全去结构化来源**。
- 不改记忆其它能力（互链 `memory_links`、SOUL、整理 everyN 等均不动）。
- 阶段二「跨书联想」若将来要做，再另起 spec 设计其数据维度，不在本期保留占位列。

## 6. 风险与回归点

- **迁移在既有库上的安全性**：表重建是删列里最重的操作；务必全量 `pnpm test`（覆盖迁移路径）而非只看 typecheck（参见既有「rebase 后重生成 drizzle 迁移」「drizzle 表重建迁移 FK 事务坑」教训）。
- **死参清理彻底性**：确认 `bookId` 从记忆链路移除后，`memory-tools.ts` / `memory-consolidation.ts` 内无残留引用（oxlint 未用变量会报）。
- **i18n 无影响**：`· 来源书名` 是数据拼接非 `t()` key，删除不涉及 locale。
