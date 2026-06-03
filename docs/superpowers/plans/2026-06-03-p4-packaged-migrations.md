# P4 · 打包期迁移路径 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 drizzle 迁移 SQL 进入打包产物，并让生产启动从产物路径加载迁移——填掉 `instance.ts` 的 `TODO(MA-packaging)`（现 prod 分支为未验证占位）。

**Architecture:** 用 Electron Forge `packagerConfig.extraResource` 把整个 `src/main/db/migrations` 目录树复制进打包产物的 `resources/`；`instance.ts` 的生产分支从 `process.resourcesPath/migrations` 读迁移（替掉 asar 内取不到的 `__dirname` 路径）。开发分支（`MAIN_WINDOW_VITE_DEV_SERVER_URL` 存在）维持读源码树不变。

**Tech Stack:** Electron Forge（`@electron-forge/plugin-vite` + packager）、drizzle-kit 迁移（rc 新格式：每迁移一子目录含 `migration.sql`+`snapshot.json`）、Electron 41（`process.resourcesPath`、`asar`、`OnlyLoadAppFromAsar` fuse）。设计依据：`docs/superpowers/specs/2026-06-03-db-lifecycle-rules-design.md` §4 / DD-§4。

**已核事实：**

- `forge.config.ts` 的 `packagerConfig` 当前仅 `{ asar: true }`。
- `instance.ts` 现 prod 分支 `path.join(__dirname, "db/migrations")` 在 asar 内取不到迁移 SQL（Vite 不打包它）；`OnlyLoadAppFromAsar` fuse 开启，app 从 asar 加载，但 `extraResource` 复制的目录落在 asar **外**的 `resources/`，经 `process.resourcesPath` 可达。
- 单测不受影响：测试用各自的 `path.resolve(__dirname, "../db/migrations")`（指源码树），不走 `instance.ts` 的分支逻辑。

> **本计划无单元测试**——打包路径只能在真实打包产物里验证。Task 2 是手动打包验证（无提交），给出精确命令与预期产物结构。

---

## File Structure

| 文件                      | 责任                                                       | Task |
| ------------------------- | ---------------------------------------------------------- | ---- |
| `forge.config.ts`         | `packagerConfig.extraResource` 复制迁移目录进 `resources/` | 1    |
| `src/main/db/instance.ts` | prod 分支改读 `process.resourcesPath/migrations`           | 1    |

---

## Task 1: 配置 extraResource + 生产迁移路径

**Files:**

- Modify: `forge.config.ts`
- Modify: `src/main/db/instance.ts`

- [ ] **Step 1: `forge.config.ts` 加 `extraResource`**

`forge.config.ts` 的 `packagerConfig`（当前第 11–13 行）：

```ts
  packagerConfig: {
    asar: true,
  },
```

替换为（迁移目录树复制进产物 `resources/`）：

```ts
  packagerConfig: {
    asar: true,
    // 迁移 SQL 不经 Vite 打包；复制整个迁移目录进 resources/，生产启动经 process.resourcesPath 读取（见 instance.ts）。
    extraResource: ["./src/main/db/migrations"],
  },
```

- [ ] **Step 2: `instance.ts` 生产分支改 `process.resourcesPath`**

`src/main/db/instance.ts` 的 `migrationsFolder`（当前第 12–17 行）：

```ts
// 开发期迁移目录在源码树。
// TODO(MA-packaging): 打包期 __dirname 在 asar 内、迁移 SQL 未被 Vite 打进产物，
// 需在打包里程碑加入 asset-copy（参考 electron-forge extraResources 把迁移目录复制到 resources/）。下面的 prod 分支是未验证的占位。
const migrationsFolder = MAIN_WINDOW_VITE_DEV_SERVER_URL
  ? path.resolve(process.cwd(), "src/main/db/migrations")
  : path.join(__dirname, "db/migrations");
```

替换为：

```ts
// 开发期迁移目录在源码树；生产期由 forge.config.ts 的 packagerConfig.extraResource
// 复制到 resources/migrations，经 process.resourcesPath 读取（asar 内取不到迁移 SQL）。
const migrationsFolder = MAIN_WINDOW_VITE_DEV_SERVER_URL
  ? path.resolve(process.cwd(), "src/main/db/migrations")
  : path.join(process.resourcesPath, "migrations");
```

- [ ] **Step 3: 类型检查 + 提交**

Run: `pnpm typecheck`
Expected: 无错误（`process.resourcesPath: string` 由 Electron 类型声明；`extraResource` 是 packagerConfig 合法字段）

Run: `pnpm test`
Expected: PASS（迁移单测走源码树路径，不受 instance.ts 分支改动影响——回归确认）

```bash
git add forge.config.ts src/main/db/instance.ts
git commit -m "build(packaging): ship drizzle migrations via extraResource (#9 P4)

forge packagerConfig.extraResource 复制 migrations 目录进 resources/；
instance.ts 生产分支改读 process.resourcesPath/migrations，填掉
TODO(MA-packaging) 的未验证占位。

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: 打包验证（手动，无提交）

**目的：** 确认迁移目录真进了产物、且产物里对全新 DB 跑迁移成功。

- [ ] **Step 1: 打包**

Run: `pnpm package`
Expected: 在 `out/` 下生成平台产物（macOS 例：`out/marginalia-darwin-<arch>/marginalia.app`）。

- [ ] **Step 2: 核对迁移目录已进产物**

macOS：
Run: `ls out/marginalia-darwin-*/marginalia.app/Contents/Resources/migrations`
Expected: 列出全部迁移子目录（`<timestamp>_<name>/`），每个含 `migration.sql` + `snapshot.json`。

（Linux 产物对应 `out/marginalia-linux-*/resources/migrations`；Windows 对应 `out/marginalia-win32-*/resources/migrations`。）

- [ ] **Step 3: 全新 DB 迁移冒烟**

用全新 userData 启动打包产物，确认迁移成功、无报错、库就绪：

macOS：
Run: `rm -rf /tmp/marginalia-pkgtest && ./out/marginalia-darwin-*/marginalia.app/Contents/MacOS/marginalia` （或在 Finder 双击启动）

人工核对：

- 应用正常启动、无「DB not initialized」「no such table」「migrations folder not found」类报错。
- 退出后检查实际 userData 库已建表：
  Run: `sqlite3 "$HOME/Library/Application Support/marginalia/marginalia.db" ".tables"`
  Expected: 列出 `books`/`chapters`/`conversations`/`messages`/`annotations`/`progress`/`providers`/`assistants`/`preferences` 等表（迁移已全部应用）。

> rc migrator 从 `process.resourcesPath/migrations` 解析子目录结构（无 `_journal.json`）。若启动报「找不到迁移」，确认 Step 2 的目录确实存在且 `extraResource` 路径无误。

- [ ] **Step 4: 记录验证结果**

把验证结论（产物路径、`.tables` 输出）记录到 PR 描述或 ROADMAP 的 D1 行；本 Task 不产生代码提交。

---

## Self-Review

**1. Spec 覆盖（对照 §4 / DD-§4）：**

- `extraResource` 复制迁移目录 → Task 1 Step 1。✅
- prod 指 `process.resourcesPath/migrations` → Task 1 Step 2。✅
- 打包后对全新 DB 跑迁移成功的验收 → Task 2。✅

**2. 占位扫描：** 无 TBD/TODO（恰恰是删掉源码里的 `TODO(MA-packaging)` 占位）；命令与预期产物结构具体到平台路径。Task 2 是真实打包的手动验证，非代码占位。✅

**3. 一致性：** `extraResource`（forge 配置）与 `process.resourcesPath/migrations`（运行时读取路径）指向同一产物位置——`extraResource: ["./src/main/db/migrations"]` 把 `migrations` 目录复制为 `resources/migrations`，运行时 `path.join(process.resourcesPath, "migrations")` 正好命中。✅

**4. 风险：** `process.resourcesPath` 在开发（`electron .`）下指向 Electron 自带 resources，故仅在 `MAIN_WINDOW_VITE_DEV_SERVER_URL` 为空（打包产物）时走该分支——开发期不受影响。Task 2 的真实打包验证覆盖此路径的唯一生效场景。✅
