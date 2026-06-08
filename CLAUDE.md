# Repository Agent Guide

This file provides guidance to coding agents working in this repository. It is shared by `CLAUDE.md` and the `AGENTS.md` symlink.

## 项目简介

Marginalia 是一个基于 Electron + React 的桌面 AI 阅读器，当前支持 ePub 与 PDF。主进程里程碑 **MA1–MA5** 与 UI 原型 **UP1** 已完成；**最小可用竖切**（导入 → 读 → 选 → 问 → 真模型流式回复）已实现并合并，渲染层 `src/renderer/` 已建（替换原 Forge 模板桩）。

> **进度真相源 = GitHub Issues + Projects kanban**（用 `kanban` skill 操作）：需求/里程碑状态、当前焦点、待办 backlog 都在那里（别在本文件里维护会过时的状态散文）。开工定位、收尾关卡（挪列 / close issue）一律走 `kanban` skill。设计细节去 `docs/superpowers/specs/`（设计）与 `docs/superpowers/plans/`（实现计划）。`docs/superpowers/ROADMAP.md` **已退役**、仅作历史归档，勿再当真相源或更新它。

## 常用命令

```bash
# 开发与构建（Electron GUI）
pnpm start          # 启动 Electron 开发模式（会阻塞）
pnpm package        # 打包
pnpm make           # 制作分发包
pnpm release        # 发布到 GitHub Release（draft+prerelease；发布前先 pnpm changeset version，发完跑 pnpm release:notes。token 现取自 gh keyring。注意 pnpm publish 是 pnpm 内置命令＝发 npm，勿用）
pnpm changeset      # 合并分支前写一条用户向英文 changelog 条目（finishing 流程一步；用户不可见的分支不写）
pnpm release:notes  # 从 CHANGELOG.md 抽当前版本段填进 GitHub Release draft 的 notes（--dry-run 仅打印不调 gh）

# 类型检查 / Lint / 格式化
pnpm typecheck      # tsc --noEmit
pnpm lint           # oxlint
pnpm lint:fix       # oxlint --fix（pre-commit hook 会自动执行）
pnpm format         # oxfmt（pre-commit hook 会自动执行）
pnpm format:check   # oxfmt --check

# 测试（headless；vitest 跑在 Electron 运行时，与 app 同 ABI，无需翻转）
pnpm test           # vitest run（一次性跑完）
pnpm test:watch     # vitest（监视模式）
pnpm test src/main/app-info.test.ts   # 运行单个文件
pnpm test -t "getAppInfo counts"         # 按测试名称过滤

# 数据库
pnpm db:generate    # drizzle-kit generate（修改 schema 后生成迁移）
pnpm db:rebuild:electron  # 将 better-sqlite3 编译为 Electron ABI（已由 postinstall 自动跑，一般无需手动）
```

## 关键注意事项（坑）

**better-sqlite3 单一 ABI（Electron）+ vitest 跑在 Electron 运行时**：原生模块的 `NODE_MODULE_VERSION` 跟的是 **V8 版本**而非 Node 版本号。Electron 41 内置 Chromium 的 V8（14.6，`-electron`，ABI **145**），独立 Node 24 自带的是 V8 13.6（`-node`，ABI **137**）——同为「Node 24」但 ABI 不同，为一方编的 `.node` 在另一方加载不了。为免来回翻转，`pnpm test` 通过 **`ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs`** 让 vitest 跑在 **Electron 运行时**，与 `pnpm start` 共用 Electron ABI（145）。因此 better-sqlite3 **始终编为 Electron ABI**，app 与测试都用它，**无需 `db:rebuild:node` 之类翻转**。唯一例外：`pnpm install`（含增删依赖）会按系统 Node 把它重编为 137——但根 `package.json` 的 **`postinstall: "pnpm db:rebuild:electron"`** 会在依赖构建脚本跑完后**自动**把它翻回 145（pnpm 在 dep build 之后执行根包 postinstall），故装包后**无需再手动翻转**；只有 postinstall 异常未跑时才手动补一刀。（脚本用 `ELECTRON_RUN_AS_NODE=` 前缀，Windows 下需 `cross-env`；当前按 macOS/Linux 开发。排障提示：`node -e "require('better-sqlite3')"` 会因 `bindings` 在 ABI 不匹配时回退试别的副本而**误报成功**，别拿它判 ABI——以 `pnpm test` 或 `ELECTRON_RUN_AS_NODE=1 electron -e "require('better-sqlite3')"` 为准。)

**Electron 锁定在 41.x（勿升 42）**：Electron 42 带 V8 14.8，其 `v8::External::New/Value` 强制要求 `ExternalPointerTypeTag` 参数，而最新的 better-sqlite3（12.10.0）源码仍用旧签名，对 Electron 42 ABI 编译失败（`pnpm start` 在 `@electron/rebuild` 阶段报 `node-gyp failed to rebuild better-sqlite3`）。上游已主动撤回 Electron 42 支持（rollback PR <https://github.com/WiseLibs/better-sqlite3/pull/1470>，确认 issue <https://github.com/WiseLibs/better-sqlite3/issues/1474>：41.5.2 可用、42.0.1 起全挂），修复 PR <https://github.com/WiseLibs/better-sqlite3/pull/1475> 截至 2026-06-01 仍 OPEN、未合并发版；本地 Node 24 的 V8 13.6 仍是旧签名，故无头 vitest 不受影响、长期掩盖了此问题。在 better-sqlite3 发布支持 Electron 42 的新版前，`electron` 固定 `41.7.1`（Electron 41 有 better-sqlite3 prebuilt，连编译都省）。

**pnpm 11 配置位置**：pnpm 11 不再读取 `package.json` 的 `pnpm` 字段，`.npmrc` 也仅保留 auth/registry；构建脚本白名单（`allowBuilds`，取代旧 `onlyBuiltDependencies`/`neverBuiltDependencies`）、`nodeLinker` 等设置一律写在 `pnpm-workspace.yaml`。**`nodeLinker` 必须设 `hoisted`**：Electron Forge 系统预检（`@electron-forge/cli` 的 `check-system` 跑 `pnpm config get node-linker`）强制要求 hoisted，isolated 会让 `pnpm start` 被拦下（Electron 打包/原生模块需扁平 node_modules）。pnpm 版本由 `package.json` 的 `packageManager` 字段（corepack）锁定。配置写错位置会让 `pnpm <script>` 在 deps 预检阶段误判依赖不一致、尝试清空重装 node_modules（无 TTY 时报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`），从而连带 prek 钩子失败。

**pre-commit hook（prek）**：`git commit` 触发 `lint:fix` + `format`，这两个步骤可能修改暂存文件并以"files were modified by this hook"中止提交。遇到时，重新 `git add` 被修改的文件，再执行一次相同的 commit 命令即可（第二次会通过）。

**提交信息**：使用 Conventional Commits 格式，例如 `docs: add shared agent guide`、`feat: add epub parser`、`fix: handle missing book metadata`。

**drizzle-kit 与 drizzle-orm 版本锁定**：两者均固定为 `1.0.0-rc.3`，最新稳定版 drizzle-kit 与当前版本不兼容，不能随意升级。

**路径别名四处同步**：`@shared/*` 和 `@main/*` 在以下四处均有定义：`tsconfig.json`、`vite.main.config.ts`、`vite.preload.config.ts`（仅 `@shared`）、`vite.renderer.config.ts`（仅 `@shared`）和 `vitest.config.ts`。新增或修改别名时必须同步更新所有相关配置。

**迁移目录格式**：drizzle-orm 1.0-rc 使用新格式——每个迁移是独立的子目录（`src/main/db/migrations/<timestamp>_<name>/`，含 `migration.sql` 和 `snapshot.json`），没有 `meta/_journal.json`。不要手工编辑迁移文件，修改 schema 后用 `pnpm db:generate` 重新生成。

**打包期 native 模块 + 迁移路径**（已解决，#9 P4）：两个独立的打包缺口，生产打包此前从未真正跑通（无头 vitest 走源码树、`pnpm start` 走 dev server 均绕开，长期掩盖）。① **迁移 SQL**：`forge.config.ts` 的 `packagerConfig.extraResource: ["./src/main/db/migrations"]` 把迁移目录复制进产物 `resources/migrations`，`instance.ts` 生产分支读 `process.resourcesPath/migrations`（asar 内取不到迁移 SQL）。② **native 模块（更隐蔽）**：Forge Vite plugin 默认令 `packagerConfig.ignore` 排除「除 `.vite/` 外一切」（含整个 `node_modules`），使被 vite external 的 better-sqlite3 不进 asar、产物启动即 `cannot find module better-sqlite3`、DB 无法初始化。修复＝自定义 `ignore` 保留 `.vite/` 与 better-sqlite3 运行时子树（require 链 → `bindings` → `file-uri-to-path`），其余 node_modules 文件一律忽略（代码已 bundle 进 `.vite`；**放行全量会让 asar 从 15M 暴涨到 334M**，故白名单裁剪是有意为之）＋ 启用 `@electron-forge/plugin-auto-unpack-natives` 把 `better_sqlite3.node` 解包出 asar 才能 dlopen。**验证**：`pnpm package` 后用 `--user-data-dir=/tmp/<x>` 启动产物（避免污染真实 userData）冒烟，`sqlite3 .../marginalia.db ".tables"` 应列出全表。

## 高层架构

### 1. 主进程厚 / 渲染层薄的硬性规则

所有业务逻辑必须在 Electron **主进程**（`src/main/`）实现；渲染层（`src/renderer/`）仅负责 UI 展示。

**两轨开发工作流**：

- **主进程核心**：无头开发，优先用 vitest 测试（`:memory:` SQLite），不依赖 Electron。
- **UI/UX 原型**：在 `packages/ui-prototype/` 中独立开发（内部使用独立 pnpm lock，不属于任何 pnpm workspace，与主应用构建完全隔离），评审通过后再移植到渲染层。

### 2. `src/shared/` 是 Zod 单一数据源

IPC 通道名、输入/输出 Zod schema 以及通过 `z.infer` 推导出的 TypeScript 类型均在 `src/shared/` 定义，被主进程（`src/main/`）和预加载脚本（`src/preload.ts`）共同导入，确保主-渲染层的类型契约无需手工维护。

核心文件：

- `src/shared/ipc.ts`：IPC 通道名常量（`IPC` 对象）、各通道的 Zod input/output schema 及推导类型。
- `src/shared/types.ts`：跨层共享的领域类型（`TocNode`、`MessageMetadata` 等）。

### 3. IPC 脊柱模式

调用链：`renderer → window.api（contextBridge）→ preload.ts → ipcMain → registry.handle() → validateInput() → 业务函数（纯函数，注入 DB）`

各层职责：

- `src/preload.ts`：通过 `contextBridge.exposeInMainWorld("api", ...)` 暴露类型安全的 `window.api`，使用 `@shared/ipc` 中的类型。
- `src/main/ipc/registry.ts`：`handle(channel, zodSchema, fn)` 封装器，调用 `validateInput` 校验不可信入参后再交给业务函数。
- `src/main/ipc/validate.ts`：`validateInput()` 用 Zod `safeParse` 校验原始入参，失败时抛出带通道名和详情的可读错误。
- `src/main/ipc/app-handlers.ts`：胶水层——调用 `handle()` 并将 `getDb()` / `app.getVersion()` 等 Electron 依赖注入给纯函数。
- `src/main/app-info.ts`：**纯函数**，接受注入的 `DB`，不引用任何 Electron API，可在 vitest Node 环境中直接测试。

这套"纯业务函数 + 胶水层注入"的设计是测试策略的核心：只有 `registry.ts`、`*-handlers.ts`、`instance.ts`、`preload.ts`、`main.ts` 接触 Electron；业务逻辑保持无头可测。

### 4. 数据库层（`src/main/db/`）

Drizzle ORM over better-sqlite3，Schema 定义在 `src/main/db/schema.ts`。

- **`client.ts`**：`createDb(filename)` 打开 SQLite 并设置 `WAL` + `foreign_keys = ON`，然后调用 `runMigrations()`；传 `":memory:"` 用于测试。
- **`instance.ts`**：DB 单例，`initDb()` 在 `app.ready` 事件中调用，`getDb()` 供其他模块获取实例。
- **ID 策略**：主键统一使用 `uuidv7`（应用侧生成）；`books.id` 是 ePub 自然键（优先用 ePub 标识符，缺失时回退文件哈希）；`chapters` 使用代理 uuid 主键 + `UNIQUE(book_id, href)` 约束（spine id 跨书不唯一）。
- **枚举列**：文本枚举列均附带 SQL `CHECK` 约束，在 DB 层强制合法值。
- **消息存储**：`messages` 表持久化 AI SDK v6 的 `UIMessage`（存 `parts` 字段）；每次请求按需派生 `ModelMessage`，不持久化。

## 代码规范（日志）

- **禁止裸 `console.*` 记录诊断信息**：主进程 `import { createLogger } from "@main/logger"`，渲染层 `@renderer/logger`；每文件模块级 `const log = createLogger("<module>")`（module 用短域名：`send`/`summary`/`library`/`db`/`ipc`/`tools`/`ai`/`reader`/`pdf`/`epub`…，参考既有分配）。logger 恒双写 console + 文件（`userData/logs/{main,renderer}-YYYY-MM-DD.log`，30 天保留）；renderer 日志双写 DevTools console 并经 IPC 落 renderer 专属文件、不回显主进程 stdout。
- **消息规范**：不带 `[xxx]` 前缀（module 段自动携带）、不带尾冒号；Error/unknown 一律作第二参（`log.warn("save failed", err)`），service 自动展开 stack 并缩进——别手动拼 err 进 message。
- **级别语义**：`error` = 不可恢复/需关注；`warn` = 降级/被吞的软失败——**凡优雅吞错处必须留 warn**（降级越优雅，日志越必要）；`info` = 关键锚点（启动标记、迁移、导入成功），克制使用防噪音；`debug` = 仅 dev 落盘。替换既有日志调用时**不得擅自升降级别语义**。
- IPC handler 抛出的错误由 `registry.ts` catch-all 自动落盘，handler 内无需重复记录；设计细节见 `docs/superpowers/specs/2026-06-07-persistent-logging-design.md`。

## 代码规范（UI 样式）

- **优先 Tailwind 工具类；非必要禁止内联 CSS（`style={{}}`）**。静态的尺寸 / 颜色 / 间距 / 字体一律用类（如 `w-80`、`max-h-40`、`bg-popover`、`font-sans`）。
- **内联 `style` 仅允许承载运行时计算值**——无法用静态类表达者，例如：浮层的计算定位（`left/top/bottom`）、自绘滚动条 thumb 的 `height/top/opacity`、随用户偏好变化的 `maxWidth/fontSize/lineHeight`。
- 字体走类：`font-sans` = Manrope（UI 文案），`font-serif` = Fraunces（阅读正文）；勿内联 `fontFamily`。

## 技术栈

| 层          | 技术                                                                                |
| ----------- | ----------------------------------------------------------------------------------- |
| 桌面框架    | Electron 41.7.1（锁定，勿升 42——见坑）+ Electron Forge + Vite 8                     |
| 语言        | TypeScript 6（strict）                                                              |
| UI          | React 19 + react-dom + i18next                                                      |
| AI          | Vercel AI SDK v6（`ai`, `@ai-sdk/react`, `@ai-sdk/anthropic`）                      |
| 数据库      | Drizzle ORM 1.0.0-rc.3 + better-sqlite3                                             |
| 校验        | Zod 4                                                                               |
| 测试        | vitest 4（Node 环境）                                                               |
| Lint/Format | oxlint + oxfmt                                                                      |
| 包管理      | pnpm 11（`nodeLinker: hoisted`，Electron Forge 强制；设置见 `pnpm-workspace.yaml`） |

## 进度管理与设计文档

- **进度真相源 = GitHub Issues + Projects kanban**（用 `kanban` skill）：需求/里程碑状态、当前焦点、待办 backlog 都在那里。开工前先看 kanban 定位「在哪 / 下一步 / 欠了什么」，收尾时用 `kanban` skill 挪列 / close 对应 issue（含合并分支时检查有无可 close 的 issue）。
- `docs/superpowers/specs/`：产品设计与技术决策的设计文档（核心阅读闭环、UP1 UI 原型、最小可用竖切）。
- `docs/superpowers/plans/`：里程碑 bite-sized 实现计划（MA1–MA5、竖切 P1–P4、RA 轨任务分解 + DAG）。
- `docs/superpowers/ROADMAP.md`：**已退役**——历史里程碑/backlog 归档，仅作上下文参考；进度管理已转入上面的 GitHub Projects kanban，勿再当真相源或更新它。

新功能开发前，先看 GitHub Projects kanban（`kanban` skill）与相关设计文档，了解进度、产品意图和架构约束。
