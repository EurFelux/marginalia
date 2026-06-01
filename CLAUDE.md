# Repository Agent Guide

This file provides guidance to coding agents working in this repository. It is shared by `CLAUDE.md` and the `AGENTS.md` symlink.

## 项目简介

Marginalia 是一个基于 Electron + React 的桌面 ePub AI 阅读器。当前状态：主进程里程碑 **MA1–MA5**（DB/IPC 脊柱、ePub 解析、Provider/密钥、会话/Prompt 组装、流式 Agent 循环）均已实现并 headless 测试；UI 原型 **UP1**（`packages/ui-prototype/`）已评审并入。渲染层（`src/renderer.ts`）仍为 Electron Forge 模板桩，真实阅读器 / AI 界面待按「渲染层轨（RA）」实装——分解见 `docs/superpowers/plans/2026-06-01-marginalia-renderer-track-decomposition.md`。

## 常用命令

```bash
# 开发与构建（Electron GUI，会重建 better-sqlite3 为 Electron ABI）
pnpm start          # 启动 Electron 开发模式（会阻塞 + 改 ABI，勿在需要跑测试前用）
pnpm package        # 打包
pnpm make           # 制作分发包
pnpm publish        # 发布

# 类型检查 / Lint / 格式化
pnpm typecheck      # tsc --noEmit
pnpm lint           # oxlint
pnpm lint:fix       # oxlint --fix（pre-commit hook 会自动执行）
pnpm format         # oxfmt（pre-commit hook 会自动执行）
pnpm format:check   # oxfmt --check

# 测试（Node ABI，headless）
pnpm test           # vitest run（一次性跑完）
pnpm test:watch     # vitest（监视模式）
pnpm test src/main/app-service.test.ts   # 运行单个文件
pnpm test -t "getAppInfo counts"         # 按测试名称过滤

# 数据库
pnpm db:generate    # drizzle-kit generate（修改 schema 后生成迁移）
pnpm db:rebuild:node  # 将 better-sqlite3 重新编译为 Node ABI（每次运行过 pnpm start 后必须执行）
```

## 关键注意事项（坑）

**better-sqlite3 ABI 双轨制**：`pnpm start` 将 better-sqlite3 编译为 **Electron ABI**；vitest 在 **Node ABI** 下运行。运行过应用后，必须执行 `pnpm db:rebuild:node` 才能再跑测试，否则会出现 ABI 不匹配错误。

**pnpm 11 配置位置**：pnpm 11 不再读取 `package.json` 的 `pnpm` 字段，`.npmrc` 也仅保留 auth/registry；构建脚本白名单（`allowBuilds`，取代旧 `onlyBuiltDependencies`/`neverBuiltDependencies`）、`nodeLinker` 等设置一律写在 `pnpm-workspace.yaml`。pnpm 版本由 `package.json` 的 `packageManager` 字段（corepack）锁定。配置写错位置会让 `pnpm <script>` 在 deps 预检阶段误判依赖不一致、尝试清空重装 node_modules（无 TTY 时报 `ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`），从而连带 prek 钩子失败。

**pre-commit hook（prek）**：`git commit` 触发 `lint:fix` + `format`，这两个步骤可能修改暂存文件并以"files were modified by this hook"中止提交。遇到时，重新 `git add` 被修改的文件，再执行一次相同的 commit 命令即可（第二次会通过）。

**提交信息**：使用 Conventional Commits 格式，例如 `docs: add shared agent guide`、`feat: add epub parser`、`fix: handle missing book metadata`。

**drizzle-kit 与 drizzle-orm 版本锁定**：两者均固定为 `1.0.0-rc.3`，最新稳定版 drizzle-kit 与当前版本不兼容，不能随意升级。

**路径别名四处同步**：`@shared/*` 和 `@main/*` 在以下四处均有定义：`tsconfig.json`、`vite.main.config.ts`、`vite.preload.config.ts`（仅 `@shared`）、`vite.renderer.config.ts`（仅 `@shared`）和 `vitest.config.ts`。新增或修改别名时必须同步更新所有相关配置。

**迁移目录格式**：drizzle-orm 1.0-rc 使用新格式——每个迁移是独立的子目录（`src/main/db/migrations/<timestamp>_<name>/`，含 `migration.sql` 和 `snapshot.json`），没有 `meta/_journal.json`。不要手工编辑迁移文件，修改 schema 后用 `pnpm db:generate` 重新生成。

**打包期迁移路径**（待解决）：`src/main/db/instance.ts` 中有 TODO 注释，生产打包时迁移 SQL 尚未被复制到产物中，需要在打包里程碑通过 `electron-forge extraResources` 处理。

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
- `src/main/app-service.ts`：**纯函数**，接受注入的 `DB`，不引用任何 Electron API，可在 vitest Node 环境中直接测试。

这套"纯业务函数 + 胶水层注入"的设计是测试策略的核心：只有 `registry.ts`、`*-handlers.ts`、`instance.ts`、`preload.ts`、`main.ts` 接触 Electron；业务逻辑保持无头可测。

### 4. 数据库层（`src/main/db/`）

Drizzle ORM over better-sqlite3，Schema 定义在 `src/main/db/schema.ts`。

- **`client.ts`**：`createDb(filename)` 打开 SQLite 并设置 `WAL` + `foreign_keys = ON`，然后调用 `runMigrations()`；传 `":memory:"` 用于测试。
- **`instance.ts`**：DB 单例，`initDb()` 在 `app.ready` 事件中调用，`getDb()` 供其他模块获取实例。
- **ID 策略**：主键统一使用 `uuidv7`（应用侧生成）；`books.id` 是 ePub 自然键（优先用 ePub 标识符，缺失时回退文件哈希）；`chapters` 使用代理 uuid 主键 + `UNIQUE(book_id, href)` 约束（spine id 跨书不唯一）。
- **枚举列**：文本枚举列均附带 SQL `CHECK` 约束，在 DB 层强制合法值。
- **消息存储**：`messages` 表持久化 AI SDK v6 的 `UIMessage`（存 `parts` 字段）；每次请求按需派生 `ModelMessage`，不持久化。

## 代码规范（UI 样式）

- **优先 Tailwind 工具类；非必要禁止内联 CSS（`style={{}}`）**。静态的尺寸 / 颜色 / 间距 / 字体一律用类（如 `w-80`、`max-h-40`、`bg-popover`、`font-sans`）。
- **内联 `style` 仅允许承载运行时计算值**——无法用静态类表达者，例如：浮层的计算定位（`left/top/bottom`）、自绘滚动条 thumb 的 `height/top/opacity`、随用户偏好变化的 `maxWidth/fontSize/lineHeight`。
- 字体走类：`font-sans` = Manrope（UI 文案），`font-serif` = Fraunces（阅读正文）；勿内联 `fontFamily`。

## 技术栈

| 层          | 技术                                                           |
| ----------- | -------------------------------------------------------------- |
| 桌面框架    | Electron 42 + Electron Forge + Vite 8                          |
| 语言        | TypeScript 6（strict）                                         |
| UI          | React 19 + react-dom + i18next                                 |
| AI          | Vercel AI SDK v6（`ai`, `@ai-sdk/react`, `@ai-sdk/anthropic`） |
| 数据库      | Drizzle ORM 1.0.0-rc.3 + better-sqlite3                        |
| 校验        | Zod 4                                                          |
| 测试        | vitest 4（Node 环境）                                          |
| Lint/Format | oxlint + oxfmt                                                 |
| 包管理      | pnpm 11（默认 isolated linker；设置见 `pnpm-workspace.yaml`）  |

## 设计文档与路线图

- `docs/superpowers/specs/`：产品设计与技术决策的设计文档（ePub 阅读核心循环设计、UP1 UI 原型设计等）
- `docs/superpowers/plans/`：里程碑实现计划。**MA1–MA5 均已完成**（MA1 主进程基础 / MA2 ePub 解析与内容 / MA3 Provider 与密钥 / MA4 会话与 Prompt / MA5 流式编排）；后续渲染层工作见 `2026-06-01-marginalia-renderer-track-decomposition.md`（RA 轨任务分解 + DAG，当前焦点：最小可用竖切）。

新功能开发前，优先阅读相关设计文档以了解产品意图和架构约束。
