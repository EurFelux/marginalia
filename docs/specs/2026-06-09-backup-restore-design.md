# 数据备份与还原设计

日期：2026-06-09
状态：已与用户对齐（待评审 spec 后转实现计划）
关联：GitHub issue #28（Data backup & restore）；数据布局依赖 `AppService`（`2026-06-07-app-service-design.md`）的 `getPath`

## 1. 背景与动机

个人单用户场景下需要一个「整体备份 / 整体还原」的逃生通道：换机迁移、误删兜底、重装前留档。数据真相源已高度收敛——**整个用户数据 = `marginalia.db` + `userData/books/` 文件夹**：

- DB（better-sqlite3，WAL）承载 books 元数据、chapters、annotations、progress、conversations、messages、preferences、providers（**含明文 API key**）、封面（blob）。
- `books/` 存导入书籍的原始文件副本（`<派生名>.<format>`）。
- `logs/` 不属于用户数据，不进备份。
- 偏好无 localStorage 分裂：渲染层 prefs-store 仅内存态，启动从 DB `preferences` 表 hydrate、变更经 `persistPreference` 落 DB——DB 即单一源。

WAL 暗坑：DB 实为三件套（`.db` + `-wal` + `-shm`），运行时直接拷 `.db` 会漏掉未 checkpoint 的事务。备份须拿**一致快照**。

## 2. 决策摘要

| 决策点          | 结论                                                                                                                                                                                                                                                                             |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 还原语义        | **整体替换**：还原用备份快照整体覆盖当前数据。简单可预测，契合 issue「overwrite confirmation」。代价（备份后新增数据会丢）用「确认弹窗 + 还原前自动 pre-restore 安全网副本」兜底。不做合并（个人场景 YAGNI，且 ID 冲突/去重/进度仲裁复杂度与出错面过大）。                       |
| API key         | **随备份走 + 导出时明文警告**。key 随 DB 进备份包，还原后开箱即用、无需重填；导出 UI 明示「此备份含明文 API key，请妥善保管」。不做「导出时剔除 key」开关（YAGNI）。                                                                                                             |
| 快照策略        | **better-sqlite3 在线 `.backup()`**：运行时拿自洽单文件快照（内部按页复制并跟随并发写，正确处理 WAL），无需关库/停写/checkpoint。优于 `wal_checkpoint(TRUNCATE)+拷文件`（会动 WAL 状态、较脆）与「整 userData 原样 zip」（含 logs、运行时拷 `-wal/-shm` 可能不一致、产物臃肿）。 |
| 打包格式        | **zip**（精选三件：db 快照 + `books/` + `manifest.json`）。                                                                                                                                                                                                                      |
| zip 库          | `archiver`（流式写）+ `yauzl`（流式读）——**纯 JS、无 native 编译**，不碰 better-sqlite3 的 Electron ABI 雷区；流式避免大书库一次性入内存。备选单依赖 `tar`（tar.gz 双向流式）被 issue 的「zip」措辞否决。                                                                        |
| 还原后接续      | **`app.relaunch()` + `app.quit()` 重启**。live DB 被渲染层 React Query/zustand 缓存包裹，热替换易留脏状态；重启让一切从干净 `initDb` 重来，并天然复用既有迁移路径（旧 schema 备份还原后于启动迁移补齐）。                                                                        |
| 版本兼容        | manifest 记 `schemaHead`＝导出方 app 最新迁移目录名（迁移目录为 `<timestamp>_<name>`，「最新」＝按名字典序末位）。还原时 `schemaHead ∈ 当前 app 迁移目录集` → 放行（旧/相等，重启迁移补齐）；否则拒绝（「备份来自更新版本，无法降级」）。判定为纯函数。                          |
| 安全网          | 还原前把当前 `marginalia.db`(+`-wal/-shm`) 与 `books/` **移**到 `userData/pre-restore-<ts>/`，使误还原可手动回滚；仅在校验通过、即将覆盖前触发，坏包早退则原数据原样保留。                                                                                                       |
| 厚主进程/纯核心 | 业务逻辑在主进程；manifest 构建与兼容性判定为注入 DB/路径的**纯函数**（无头可测），fs/zip/dialog/relaunch 收于薄胶水层。                                                                                                                                                         |

## 3. 架构与模块边界

### 3.1 `src/shared/backup.ts`（Zod 单一源）

- `BackupManifest` schema 与推导类型（见 §4）。
- IPC 通道与 input/output schema：
  - `backup:export`：input 无（路径走主进程 saveDialog）；output `{ path: string }`。
  - `backup:inspect`：input `{ path }`；output `{ manifest, compatible: boolean, reason?: string }`（供还原确认弹窗预览 + 兼容性判定）。
  - `backup:restore`：input `{ path }`；output `{ ok: true }`（随后主进程 relaunch）。

### 3.2 纯核心（注入依赖，vitest 无头可测）

- `buildManifest(db, { appVersion, schemaHead, includesApiKeys, dbSha256 }): BackupManifest`——读取 `bookCount` 等计数，组装 manifest。
- `checkRestoreCompatibility(bundleSchemaHead, knownMigrationDirs): { compatible: boolean; reason?: string }`——纯判定；`knownMigrationDirs` 为当前 app 全部迁移目录名集合（由胶水层枚举迁移目录后注入）。

### 3.3 胶水层（碰 Electron/fs/zip，薄）

- `exportBackup`：`.backup()` 快照→`buildManifest`→流式写 zip→移到 saveDialog 目标→清临时。
- `inspectBackup`：只读 zip 内 `manifest.json`，跑兼容性判定，返回预览 + 结论。
- `restoreBackup`：校验完整性→移当前数据进 pre-restore→解包 db+books 进 userData→关 DB→relaunch。
- db 模块新增**底层 better-sqlite3 句柄出口**（现 `createDb` 仅返回 drizzle 实例），供 `.backup()` 调用。

## 4. 备份包格式

```
marginalia-backup-YYYYMMDD-HHMMSS.zip
├── manifest.json
├── marginalia.db          # .backup() 一致快照（WAL 已折叠为单文件）
└── books/                 # userData/books/* 原样副本
```

`manifest.json`（`BackupManifest`）字段：

| 字段              | 含义                                                  |
| ----------------- | ----------------------------------------------------- |
| `formatVersion`   | 备份包格式版本（整数，从 1 起），未来格式演进的判别位 |
| `appVersion`      | 导出方 app 版本（`app.getVersion()`），仅展示用       |
| `schemaHead`      | 导出方最新迁移目录名，版本兼容判定依据                |
| `createdAt`       | 导出时间戳                                            |
| `bookCount`       | 书籍数，确认弹窗展示用                                |
| `includesApiKeys` | 是否含明文 key（恒 true；保留位以备未来剔除开关）     |
| `dbSha256`        | db 快照的 sha256，还原前完整性校验                    |

## 5. 流程

### 5.1 导出

1. 渲染层「设置 → 数据」点「导出备份」，内联明示含明文 API key。
2. 主进程 `dialog.showSaveDialog` 选目标路径（默认文件名带时间戳）。
3. `.backup()` 快照到临时文件 → 算 dbSha256 → `buildManifest` → 流式写 zip（快照作 `marginalia.db` + 拷 `books/` + 写 `manifest.json`） → 移到目标 → 清临时。
4. 回报 `{ path }` 或可读错误。

### 5.2 还原

1. 渲染层「还原备份」→ `dialog.showOpenDialog` 选 .zip。
2. `backup:inspect`：读 manifest + 兼容性判定。不兼容 → 返回拒绝原因，渲染层报错中止。
3. 渲染层确认弹窗：展示备份日期 / 书籍数 / app 版本 + **「将替换全部当前数据」**警告 + 「当前数据会先存一份 pre-restore 副本」。
4. 确认 → `backup:restore`：
   - 校验 dbSha256；校验 DB 引用的每本书文件在包内存在（缺失则报哪本并拒绝）。
   - 移当前 `marginalia.db`(+`-wal/-shm`) 与 `books/` 进 `userData/pre-restore-<ts>/`。
   - 解包 zip 的 db + books 进 userData。
   - 关 DB 连接 → `app.relaunch()` + `app.quit()`；下次启动 `initDb` 自动迁移。

## 6. 错误处理

- **版本不兼容**（备份更新）：`inspect` 阶段拦下，不进入还原，原数据零触碰。
- **完整性失败**（dbSha256 不符 / 书文件缺失）：还原校验阶段拒绝，安全网未触发即原数据原样保留。
- **坏包 / 缺 manifest / 非法 zip**：可读错误中止。
- **导出写失败**：清理临时文件，回报错误。
- 所有优雅降级与被吞软失败留 `warn` 日志（按项目日志规范，module 段如 `backup`）；IPC handler 抛错由 `registry.ts` catch-all 落盘，handler 内不重复记。

## 7. 测试

- **纯 vitest**：`buildManifest`（`:memory:` + seed 计数）、`checkRestoreCompatibility`（旧/同/新三类用例表）、`BackupManifest` Zod 解析（合法/缺字段/类型错）。
- **集成 vitest**（Electron 运行时 + 临时目录，真 fs）：导出产物 zip 条目与 manifest 断言；导出→还原 roundtrip 进临时 userData，DB 可开、行数/关键数据一致。把「移当前数据 + 解包覆盖」抽成**注入路径的可测函数**，仅 `relaunch` 留胶水（无头测覆盖文件搬运与解包，不测 relaunch）。
- **冒烟**：dev/打包真 app，导出 → 改数据（如删一本书） → 还原 → 确认重启 + 数据回滚；并验 pre-restore 副本生成。

## 8. UI

设置页新增「数据 / 备份与还原」板块：

- 「导出备份」按钮 + 明文 key 警告文案。
- 「还原备份」按钮 → 确认弹窗（备份预览 + 替换警告 + 安全网说明）。
- 遵循既有设置 UI 模式：Tailwind 工具类、`font-sans`、i18n（`t()`），不内联静态样式。

## 9. 非目标（YAGNI）

- 合并式还原、增量/自动定时备份、云同步。
- 导出时剔除 API key 的开关。
- 备份包加密。
- pre-restore 副本的自动清理/保留策略（仅生成；手动清理由用户负责，未来可补）。
