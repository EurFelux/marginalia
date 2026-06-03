# DB 生命周期规则设计（issue #9）

> **Issue**：#9 `chore: define DB lifecycle rules for deletes, summaries, AI runs, and files`
> **父任务**：#7（收紧 IPC / renderer state / DB lifecycle 架构边界）
> **日期**：2026-06-03
> **性质**：**定义型设计文档**——本文档**定义规则**，实现拆成 §5 的独立 plan 增量落地。

## 背景

若干 backlog 项共享同一根问题：DB 生命周期规则尚未完整建模。这些不是孤立的清理项，它们定义了**事实如何在删除、崩溃、重试、迁移、打包中存活**。本文档为五块债一次性定下规则：

1. FK 级联在 `books → chapters/progress/conversations/messages/annotations` 上不统一。
2. `chapters.summary_status` 持久化了运行时态，与全书摘要已采用的派生态不一致。
3. AI 发送会在模型完成前持久化 user 消息，但失败/中止/重试/用量没有正式的消息状态模型。
4. 导入的 ePub 仍依赖外部路径，而非 app 自有副本。
5. 打包期迁移 SQL 路径未解决。

---

## §0 · 统一原则（贯穿全文的标尺）

> **持久化「重启后仍然为真」的耐久事实；派生 / 内存化「仅在进程运行期间有意义」的瞬态。**

判据：**重启后这条信息还成立吗？**

- `generating`（摘要生成中）重启即失效 → **内存**。
- 「这一轮 `error` 了」「token 用量」「文件存在 `userData/books/`」重启后依然成立 → **入库**。

| 分类                      | 内容                                                                                                                                                                                               |
| ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **耐久事实（入库）**      | 书/章元数据、`summary` **正文**、progress、annotations、conversations、messages、一轮的**终态**（`complete`/`error`/`aborted`）、**token usage**                                                   |
| **派生 / 内存（不入库）** | 摘要**状态**（由 `summary!=null` + 内存集派生）、AI **运行中**瞬态（streaming partial）、崩溃残留的复位逻辑、**app 自有文件路径**（由 `bookId` 确定性派生 `userData/books/<sha256(bookId)>.epub`） |

这条原则使看似相反的 §2（**去** `summary_status` 列）与 §3（**加**终态列）统一于同一把尺子：前者是瞬态、后者是耐久事实。

---

## §1 · 删除与文件生命周期簇（#1 FK 级联 + #4 文件自有化 + 删书）

这三者紧耦合：删书必须同时知道**依赖行如何级联**与**文件存在哪**，才能安全清理。故合为一簇定义。

### §1.1 · FK 级联（删书时依赖行的归宿）

现状：`schema.ts` 中所有 `references(books.id)` 与 `references(conversations.id)` **零** `onDelete`。删书功能尚未实现，故暂无孤儿行；但删书落地前必须先统一级联规则。

**级联图**：

```
books ─CASCADE→ chapters ─CASCADE→ conversations.chapterId
      ─CASCADE→ progress (1:1)
      ─CASCADE→ annotations
      ─CASCADE→ conversations ─CASCADE→ messages

assistants ←─ conversations.assistantId   （不级联：assistant 全局共享，删书不删它）
```

**规则**：

| FK                                        | 行为                    | 理由                                     |
| ----------------------------------------- | ----------------------- | ---------------------------------------- |
| `chapters.bookId → books`                 | `ON DELETE CASCADE`     | 章属于书                                 |
| `progress.bookId → books`                 | `ON DELETE CASCADE`     | 进度属于书                               |
| `annotations.bookId → books`              | `ON DELETE CASCADE`     | 标注属于书                               |
| `conversations.bookId → books`            | `ON DELETE CASCADE`     | 会话属于书                               |
| `messages.conversationId → conversations` | `ON DELETE CASCADE`     | 消息属于会话                             |
| `conversations.chapterId → chapters`      | `ON DELETE CASCADE`     | 章随书删时，章级会话本就随书删           |
| `conversations.assistantId → assistants`  | **不级联**（NO ACTION） | assistant 是跨书共享资源，删书绝不能波及 |

**声明式 CASCADE vs 手动事务清理 → 选 CASCADE**：声明式、不会漏表、DB 层原子；`createDb` 已 `PRAGMA foreign_keys = ON`，`runMigrations` 已在事务外切 FK（`client.ts:28`，坑已填），表重建迁移安全。

**实现**：SQLite 无法 `ALTER` 已存在的 FK，需**表重建迁移**（建新表→拷贝→DROP 旧表→改名）。用 `pnpm db:generate` 生成；勿手编。

### §1.2 · 文件自有化

| 维度       | 现状                                                                  | 设计                                                                                                                                                                                                   |
| ---------- | --------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 存储       | `books.path` = 用户**外部原始路径**（`repository.ts:35`）；导入不复制 | 导入时**复制**字节到 app 自有位置 `storedEpubPath(bookId)`（见下注）；**删除 `books.path` 列**——位置由 `bookId` **确定性派生**、不入库，所有读取（`book-bytes.ts`、章节文本、摘要、工具）改走该 helper |
| 来源       | 无                                                                    | **不持久化**（YAGNI）：relink 靠用户重选 + 内容哈希匹配，无需旧来源；如需「显示导入来源」再加 `sourcePath`（届时为非派生耐久事实）                                                                     |
| 缺失文件   | `readFile` 裸抛 `ENOENT`，孤儿书留库                                  | 读 `storedEpubPath(bookId)` 失败 → **派生** missing 态（**不持久化**标志）；UI 给 relink / 重导（重选文件 → 按 `bookId` 内容匹配 → 重新复制到派生位置）                                                |
| 存量书回填 | —                                                                     | 既有书带 legacy 外部 `path`：**先读旧列**把文件复制到派生位置，再**删 `path` 列**；源已失则标 missing。**不阻塞启动**                                                                                  |

> **文件名安全**：`bookId` 可能是 ePub UID（`urn:uuid:…` / `http://…`，含 `:` `/` 等文件系统非法字符），故派生用 `sha256hex(bookId)` 编码、不裸用；编码函数须**永久稳定**（改了旧文件即失联）。`bookId` 由 ePub 自然键 / 文件哈希决定（`repository.ts:24`），与磁盘路径解耦，relink / 重导按内容匹配回同一本书（幂等）。

### §1.3 · 删书操作

删书 = **DB 事务删**（依赖行靠 §1.1 CASCADE 自动清）**＋ best-effort `unlink` 派生位置 `storedEpubPath(bookId)` 的自有副本**。

- **顺序：先删 DB 行（真相源），再尽力删文件**。文件删失败只记日志。
- 残留无主文件 = 无害磁盘泄漏（可选：启动时扫 `userData/books/` 清无对应 DB 行的文件做 GC）。
- 反向（先文件后 DB）被否决：留下指向已删文件的 DB 行 = 书库里打不开的鬼书，更糟。

---

## §2 · 章节摘要改派生态（#2，镜像全书摘要）

全书摘要已是派生态（只持久化 `summary` 正文，状态由内存 `inFlightBooks`/`failedBooks` 集 + `summary!=null` 派生，见 `summary.ts:86` `getBookSummaryView`）。章节摘要仍持久化 `summary_status` 运行时态，靠 `resetStuckSummaries`（`summary.ts:185`）开机复位崩溃残留的 `generating`——这正是「持久化瞬态」的病根。改为镜像 book 模式：

| 改动点     | 现状                                                         | 目标                                                                                                                                                                         |
| ---------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| schema     | `chapters.summary_status` 列 + CHECK                         | **删列删 CHECK**（表重建迁移）                                                                                                                                               |
| summary.ts | `inFlight` 单集 + 写 DB status                               | 加 `inFlightChapters` / `failedChapters` 两内存集（keyed by chapterId）；新尝试时 `failedChapters.delete()`（失败可自动重试）                                                |
| 读         | `getChapterSummary`（`content.ts`，读 status 列）            | 移到 summary.ts 作 `getChapterSummaryView` 派生：`inFlight`→`generating` ／ `summary!=null`→`ready` ／ `failed`→`unavailable` ／ else→`pending`（镜像 `getBookSummaryView`） |
| 写         | `ensureChapterSummary` 写 `generating`/`ready`/`unavailable` | 去掉所有 DB status 写，只管两内存集；门控 `summary==null && !inFlight`（或 `force`）                                                                                         |
| 启动       | `instance.ts:21` 调 `resetStuckSummaries`                    | **删除**该函数 + 调用（派生态重启自愈，无需复位）                                                                                                                            |
| 测试       | —                                                            | 加 `__resetChapterSummaryRuntime()` 隔离；补 `failed` 派生 + 重启语义用例                                                                                                    |

- **DTO `{ status, summary }` 形状不变 → IPC / renderer 契约零改动**（`SummaryPill`、开章自动摘要、`send.ts` 注入均不动）。
- 章节摘要**维持非流式**（`generateText`，512 token，无需 partial）——不引 `streamingChapters` map（YAGNI）。

---

## §3 · AI run / 消息终态模型（#3）

**选定方案：消息终态标记**（非 runs 表、非原子轮）。

### 数据模型

`messages` 表加**终态列**（沿用项目「enum 列 + CHECK」惯例，与 `role`/`style` 一致）：

```
messages.status  text  NOT NULL  default 'complete'  CHECK in ('complete','error','aborted')
```

- 仅 assistant 行会出现非 `complete`；user/system 提交即完整，恒为 `complete`。
- **写一次的终态**，绝不在进程运行中被改 → 符合 §0，非「持久化运行时态」。
- `default 'complete'` 是兜底（给 user/system 行与防御性 insert）；assistant insert **永远显式传**终态值。enum **不含** `running`/`pending`——见 DD-§3.1，进行中态从不入库。

`MessageMetadata`（`shared/types.ts:22`）扩两字段：

```ts
usage?: { inputTokens: number; outputTokens: number }   // 改成真填（现已定义但从不填充）
error?: { name: string; message: string }               // 透传 provider 真实 name/message
```

- `usage` 从 SDK `onFinish` 取；失败 / 中止也尽量记已耗 token（用量是耐久事实）。
- `error` 遵循 `honest-error-no-fabrication`：**透传真实** name/message，不编造；结构化 `reason` 分类是另一项延后债（ma5-deferred #6），本设计不掺。`aborted` 态**不带** error 对象（它不是错误）。

### 落库规则（替换 `send.ts:145` 的双守卫跳过逻辑）

| 终态     | parts                | status     | metadata                      | 处理                                                           |
| -------- | -------------------- | ---------- | ----------------------------- | -------------------------------------------------------------- |
| 正常完成 | 完整回复             | `complete` | usage                         | 同现状（onFinish 落 assistant）                                |
| 模型报错 | 报错前已流出 / 空    | `error`    | usage + `error{name,message}` | **补落** assistant                                             |
| 用户中止 | 已流出的**部分文本** | `aborted`  | usage                         | **补落** assistant，**保留 partial**（中止前的回答有用，不丢） |

写入逻辑大致：

```ts
onFinish: ({ responseMessage, isAborted }) => {
  const status = streamHadError ? "error" : isAborted ? "aborted" : "complete";
  appendMessage(db, {
    conversationId,
    role: "assistant",
    parts: responseMessage.parts,
    status,
    metadata: { model: resolved.modelId, usage, error: streamHadError ? errorInfo : undefined },
  });
};
```

（`errorInfo` 由 `onError` 捕获时记下的 `{ name, message }`。）

### 写库时刻（仅两个写点）

| 行               | 时刻                                                  | 次数 |
| ---------------- | ----------------------------------------------------- | ---- |
| **user 行**      | 用户提交那一刻立即写（`send.ts:81`，调模型前）        | 1    |
| **assistant 行** | **仅在一轮终止时写一次**（`onFinish`/`onError` 路径） | 1    |

整个 streaming 过程 DB 对 assistant 一无所知（partial 全在内存，§0）。assistant 行**出生即终态**，无「先插 running、再 UPDATE」。

### DD-§3.1 · 崩溃不持久化未完成轮（已接受的 trade-off）

> **决策**：assistant 消息**仅在受控终止**（`onFinish`/`onError`）时一次性写库；进程**硬崩溃**（断电 / 被 kill）流到一半时，未完成轮的 assistant **不落库**。
>
> **理由**：直接结论是「只在完成（终止）时写库」，因而崩溃场景下进行中的消息不会被持久化——这避免了持久化「运行中」瞬态（§0）；终态标记模型里**不存在**可被崩溃卡住的活动行（这正是它比 `ai_runs` 表轻的根因：runs 表要存 `pending→running→done` 过程、`running` 是瞬态、崩溃会卡住）。
>
> **代价**：崩溃会丢失「用户问过、但模型没回复」的精确痕迹，以及中止前已流出的 partial。判定为**可接受**（硬崩溃罕见，且已否决 runs 表 + 恢复方案）。
>
> **缓解**：崩溃后该轮表现为「会话尾消息是 user 行」，**读时派生**为「未完成轮」，renderer 据此给重试入口——零持久化。
>
> **放弃的替代**：`ai_runs` 表 + 跨重启恢复（与「去持久化运行态」方向冲突）。

由此三类终止各归其位：

| 终止方式 | 回调                   | DB 留下                                        | 怎么识别                   |
| -------- | ---------------------- | ---------------------------------------------- | -------------------------- |
| 报错     | `onError` + `onFinish` | assistant 行 `status=error` + `metadata.error` | 读 status                  |
| 中止     | `onFinish(isAborted)`  | assistant 行 `status=aborted` + partial        | 读 status                  |
| **崩溃** | 无                     | 只有 user 行                                   | **派生**：尾消息是 user 行 |

### DD-§3.2 · 为何区分 `error` 与 `aborted`

不靠捕获 / 嗅探 `AbortError` 判断中止——abort 是我们用 `AbortController` 触发的，SDK 的 `onFinish` 直接回传权威的 `isAborted: true`。写库那刻「这是中止」是**已知事实**；折叠进 `error` 后靠 `error.name === 'AbortError'` 反推是**脆弱重建**（SDK 可能包一层、provider 命名不一）。**记录已知事实，别去重建能丢失的东西**（与 DD-§3.1 同源）。

区分换来三处实打实差异：

|         | `aborted`（用户主动停）            | `error`（非自愿失败）                      |
| ------- | ---------------------------------- | ------------------------------------------ |
| 语义    | 非失败，partial 是用户要的有效内容 | 失败，partial 多半残缺 / 空                |
| UX      | 中性「已停止」，可继续 / 重生成    | 错误样式 + 原因 + 醒目重试                 |
| 重试    | 留 partial，用户要才删替           | 删 error 行重跑                            |
| payload | partial 文本，**无** error 对象    | **需** `error{name,message}`，partial 可空 |

### 重试规则

- `error` 行 = 失败留痕；重试 = **删除该失败 assistant 行 + 按原 user 消息重跑**（user 不重复落、不留双胞胎）。
- `aborted` 行 = 保留 partial；用户要保留就留、要重来才删替。

### 消费方影响（渲染层，属 RA 轨，不在 #9 主进程范围）

renderer 历史回放现把 error 当**瞬态气泡**；改后失败 / 中止 / 崩溃（尾 user 派生）轮成为**显式历史**，需按 `status` 渲染「失败 + 重试」「已中止」「未完成 + 重试」样式。spec 在此标注，实现归 RA 轨 UI plan。

---

## §4 · 打包期迁移路径（#5，= D1 里程碑）

填掉 `instance.ts:13` 的 `TODO(MA-packaging)`（现 prod 分支为「未验证占位」，迁移 SQL 未进打包产物）：

- **`forge.config.ts`** 加 `packagerConfig.extraResource: ["./src/main/db/migrations"]` → 打包时整个迁移目录树（rc 新格式：每迁移一子目录含 `migration.sql` + `snapshot.json`，无 `_journal.json`）复制进 `resources/`。
- **`instance.ts`** prod 分支改 `path.join(process.resourcesPath, "migrations")`，替掉现 `path.join(__dirname, "db/migrations")`。
- **验收**：`pnpm package` 后在产物里对全新 DB 跑迁移成功（rc migrator 能从 `resourcesPath` 解析子目录）。

---

## §5 · 分拆计划（spec 落地后拆成的可执行 plan）

按**耦合度**而非 issue 文字平铺拆分。每个 Pn = 一份 `docs/superpowers/plans/` 文档，可各开分支增量合并。

| Plan                                     | 内容                                                                                                                                                                                                                    | 依赖               | 风险                           |
| ---------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ | ------------------------------ |
| **P1 · 章节摘要派生态**（§2）            | 删 `summary_status` 迁移 + summary.ts 重构 + 删 `resetStuckSummaries` + 测试                                                                                                                                            | 无                 | 低（机械、契约不变）——适合打头 |
| **P2 · AI 终态模型**（§3）               | 加 `status` 列迁移 + `metadata.usage` 真填 + `error{name,message}` + `send.ts` onFinish 重写 + 尾-user 派生 helper + 测试                                                                                               | 无                 | 中                             |
| **P3 · 删除 + 文件簇**（§1，内部分阶段） | P3a 全 owned 子表 CASCADE 迁移 → P3b 删 `books.path` 列 + `storedEpubPath` 派生 helper + 文件复制进派生位置 + missing 派生 + 惰性回填（先读 legacy path 再删列） → P3c 删书服务（DB 级联删 + best-effort unlink）+ 测试 | P3c 依赖 P3a + P3b | 中-高                          |
| **P4 · 迁移打包**（§4 = D1）             | `extraResource` + prod 路径 + 打包验证                                                                                                                                                                                  | 无                 | 低-中（需真打包验证）          |

- P1 / P2 / P3 / P4 **彼此独立**，可各自 PR；仅 P3 内部 a→b→c 有序。
- 渲染层 error / aborted / missing 显示属 **RA 轨 UI**，不进 #9 主进程 plan。

---

## 验收标准映射（#9）

| #9 验收标准                                        | 由          | Plan |
| -------------------------------------------------- | ----------- | ---- |
| 删书生命周期显式设计并测试                         | §1.1 + §1.3 | P3   |
| FK 级联 / 手动清理跨表一致                         | §1.1        | P3a  |
| 章节摘要状态不再无必要持久化运行时态               | §2          | P1   |
| AI 失败 / 中止 / 重试 / 用量可表达，无歧义半轮历史 | §3          | P2   |
| 导入文件 app 自有，或有明确缺失恢复路径            | §1.2        | P3b  |
| 打包产物含迁移文件                                 | §4          | P4   |

---

## 设计决策记录（速查）

- **DD-§0**：持久化耐久事实，派生 / 内存化瞬态（判据：重启后是否仍为真）。
- **DD-§1.1**：owned 子表全 `ON DELETE CASCADE`（声明式 > 手动清理）；`assistants` 共享不级联。
- **DD-§1.2**：**删 `books.path` 列**——文件存派生位置 `userData/books/<sha256(bookId)>.epub`（由 bookId 派生、不入库）；`sourcePath` YAGNI 不存；missing 派生不持久化；存量先读旧 `path` 回填再删列。
- **DD-§1.3**：删书「DB 先、文件后（best-effort）」——无主文件可 GC，幽灵 DB 行更糟。
- **DD-§2**：章节摘要镜像全书派生态，去 `summary_status` 列 + 删 `resetStuckSummaries`；维持非流式。
- **DD-§3（选型）**：消息终态标记，非 runs 表。
- **DD-§3.1**：崩溃不持久化未完成轮（已接受 trade-off；尾-user 派生缓解）。
- **DD-§3.2**：区分 `error`/`aborted`（`isAborted` 权威，记录已知事实而非嗅探 `AbortError`）。
- **DD-§4**：`extraResource` 复制迁移目录 + prod 指 `process.resourcesPath`。
