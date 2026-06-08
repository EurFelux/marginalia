# epub-parser 预构建为自包含 ESM 产物 — 实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 `@marginalia/epub-parser` 用 tsup 预构建为自包含 ESM dist（CJS 依赖 build 期内联），消除渲染层 Vite `optimizeDeps.include` 的 CJS 维护负担与反复 stale 翻车。

**Architecture:** epub-parser 从「源码包（main 指 src）」改为「自包含 ESM 产物包（main 指 dist，node-html-parser/fflate/fast-xml-parser 全 `noExternal` 内联）」。dist 仍是软链包故 Vite 仍 `exclude`（避 stale），但因无外部 CJS import，`include: ["node-html-parser"]` 整条删除。所有消费者（主进程 Rollup / 渲染层 Vite exclude 直供 / vitest / tsc）统一走 dist，靠 `build:packages` 在 `start`/`typecheck`/`test`/`postinstall` 前显式 `&&` 串联保 dist 新鲜。

**Tech Stack:** tsup（esbuild 底座，出 ESM + `.d.ts`）、concurrently（dev watch + electron 并跑）、pnpm workspace、Vite 8 optimizeDeps。

**与 spec 的差异（已自审认可）：** spec §4.4 用 `pre*` 生命周期钩子；本计划改用**显式 `&&` 串联**（`pnpm build:packages && <cmd>`），规避 pnpm `enable-pre-post-scripts` 默认值不确定导致钩子静默不跑的风险。语义等价、更稳。

**关键事实（实现时复用，勿重查）：**

- `esbuild` 已在 `pnpm-workspace.yaml` 的 `allowBuilds: true`（line 23）→ tsup 底层 esbuild 安装脚本不会被 pnpm 拦。
- epub-parser 已是 `"type": "module"`、`"private": true`。
- epub-parser 渲染层唯一消费点：`src/renderer/reader/epub-book.ts:3` 的 `htmlToText`。
- `makeFixtureEpub` 被 8+ 个主进程测试 import（`@marginalia/epub-parser` 主入口，**不拆子入口、不改这些 import**）。
- 最新版本（参考，实际用 `pnpm add` 自动解析）：tsup 8.5.1、concurrently 10.0.3。

---

## File Structure

| 文件                                  | 动作   | 职责                                                                                                        |
| ------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------- |
| `packages/epub-parser/tsup.config.ts` | Create | tsup 构建配置：entry src/index.ts、ESM、dts、全依赖 noExternal                                              |
| `packages/epub-parser/package.json`   | Modify | main/module/types/exports 改指 dist；加 build/dev 脚本；加 tsup devDep                                      |
| `package.json`（根）                  | Modify | 加 `build:packages`；`start`/`typecheck`/`test` 前 `&&` build；postinstall 串 build；加 concurrently devDep |
| `vite.renderer.config.ts`             | Modify | 删 `include: ["node-html-parser"]`；从 exclude 删 pdf-parser；更新注释                                      |
| `.gitignore`                          | Modify | 忽略 `packages/*/dist/`                                                                                     |
| `.oxfmtrc.json`                       | Modify | ignorePatterns 加 `packages/*/dist/**`（双保险）                                                            |
| `.oxlintrc.json`                      | Modify | 加 `ignorePatterns: ["packages/*/dist/**"]`（双保险）                                                       |

---

## Task 1: tsup 构建 epub-parser 为自包含 dist（不切 exports，先验证产物）

先让 tsup 能产出正确的自包含 dist，但**暂不改 exports/main**（exports 仍指 src），保证 app/test/typecheck 全程不破。

**Files:**

- Create: `packages/epub-parser/tsup.config.ts`
- Modify: `packages/epub-parser/package.json`（仅加 `build`/`dev` 脚本 + tsup devDep，**不动 main/exports**）

- [ ] **Step 1: 装 tsup 到 epub-parser 包**

Run:

```bash
pnpm --filter @marginalia/epub-parser add -D tsup
```

Expected: `package.json` 的 devDependencies 出现 `tsup`，无报错（esbuild 已白名单，不会有 ERR_PNPM_IGNORED_BUILDS）。

- [ ] **Step 2: 创建 tsup.config.ts**

Create `packages/epub-parser/tsup.config.ts`:

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  // 内联所有运行时依赖，dist 自包含、零外部 import——这是清空渲染层 vite optimizeDeps.include 的前提。
  noExternal: ["node-html-parser", "fflate", "fast-xml-parser"],
});
```

- [ ] **Step 3: 加 build/dev 脚本（暂不改 main/exports）**

在 `packages/epub-parser/package.json` 的 `scripts` 加 `build` 与 `dev`（保持 main/types/exports 仍指 `./src/index.ts`）:

```json
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  },
```

- [ ] **Step 4: 跑 build，产出 dist**

Run:

```bash
pnpm --filter @marginalia/epub-parser build
```

Expected: 生成 `packages/epub-parser/dist/index.js` 与 `packages/epub-parser/dist/index.d.ts`，无报错。

- [ ] **Step 5: 验证 dist 自包含（无外部 CJS import）**

Run:

```bash
grep -nE "from ['\"](node-html-parser|fflate|fast-xml-parser)['\"]|require\(['\"](node-html-parser|fflate|fast-xml-parser)" packages/epub-parser/dist/index.js || echo "SELF-CONTAINED: no external dep imports"
```

Expected: 打印 `SELF-CONTAINED: no external dep imports`（依赖已内联，dist 不再 import 它们）。

- [ ] **Step 6: 验证关键导出存在于 d.ts**

Run:

```bash
grep -E "htmlToText|parseEpub|makeFixtureEpub|TocNode|ChapterTextSlice" packages/epub-parser/dist/index.d.ts | head
```

Expected: 列出 `htmlToText`/`parseEpub`/`makeFixtureEpub`/`TocNode`/`ChapterTextSlice` 等声明。

- [ ] **Step 7: 确认现状未破（exports 仍 src，app 不受影响）**

Run:

```bash
pnpm typecheck
```

Expected: PASS（此时 exports 仍指 src，typecheck 走源码，全绿）。

- [ ] **Step 8: Commit**

```bash
git add packages/epub-parser/tsup.config.ts packages/epub-parser/package.json pnpm-lock.yaml
git commit -m "build(epub-parser): add tsup, build self-contained ESM dist"
```

（若 prek format/lint 修改文件并中止，`git add` 被改文件后重跑同一 commit。）

---

## Task 2: 切 exports 指 dist + 删除 Vite optimizeDeps workaround

核心切换：消费契约改指 dist，同步删掉渲染层的 `include` 与 pdf-parser 噪音。先把根脚本接好 `&& build`，保证切换后 typecheck/test 仍能拿到新鲜 dist。

**Files:**

- Modify: `package.json`（根）—— 加 `build:packages`、`typecheck`/`test` 前置 build、concurrently devDep
- Modify: `packages/epub-parser/package.json` —— main/module/types/exports 指 dist
- Modify: `vite.renderer.config.ts` —— 删 include + pdf-parser exclude + 改注释

- [ ] **Step 1: 装 concurrently 到根包**

Run:

```bash
pnpm add -D -w concurrently
```

Expected: 根 `package.json` devDependencies 出现 `concurrently`。

- [ ] **Step 2: 根 package.json 接线脚本（显式 && build）**

修改根 `package.json` 的 `scripts`，把下列键改成（其余键不动）:

```json
    "start": "pnpm build:packages && concurrently -k -n epub,app \"pnpm --filter @marginalia/epub-parser dev\" \"electron-forge start\"",
    "typecheck": "pnpm build:packages && tsc --noEmit",
    "test": "pnpm build:packages && ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run",
    "test:watch": "pnpm build:packages && ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs",
    "build:packages": "pnpm --filter @marginalia/epub-parser build",
    "postinstall": "pnpm build:packages && pnpm db:rebuild:electron",
```

- [ ] **Step 3: 切 epub-parser 消费契约指向 dist**

修改 `packages/epub-parser/package.json` 的 main/types/exports，并加 module:

```json
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    }
  },
```

- [ ] **Step 4: 删除 Vite optimizeDeps workaround**

把 `vite.renderer.config.ts:35-43` 的 optimizeDeps 块及上方注释整体替换为:

```ts
  // 工作区源码包（经软链消费）不要预打包：Vite 会 bundle 进 .vite/deps 并缓存，缓存失效只看
  // lockfile/config、不看软链源码 mtime——改了包源码运行时仍用旧产物。排除后 Vite 从源码直供，
  // 源码改动即时生效、HMR 正常。
  // epub-parser 已预构建为自包含 ESM（dist/index.js，node-html-parser 等 CJS 依赖 build 期内联），
  // 故无需再 include 其 CJS 传递依赖；仍 exclude 以避软链 dist 的 stale 缓存。
  // pdf-parser 渲染层不消费（仅主进程经 Rollup bundle），不在此列。
  optimizeDeps: {
    exclude: ["@marginalia/virtual-docs", "@marginalia/epub-parser"],
  },
```

- [ ] **Step 5: typecheck（走 dist，验证类型契约不破）**

Run:

```bash
pnpm typecheck
```

Expected: PASS——根 `tsc` 经 `&& build` 先产 dist，主进程 `import { type TocNode }` 等从 `dist/index.d.ts` 解析成功。

- [ ] **Step 6: 全量测试（主 app 经 dist 消费 epub-parser）**

Run:

```bash
pnpm test
```

Expected: PASS——所有测试通过；`makeFixtureEpub` 从 dist 主入口解析（8+ 测试 import 未改仍工作），`htmlToText` 文本长度口径不变。

- [ ] **Step 7: Commit**

```bash
git add package.json packages/epub-parser/package.json vite.renderer.config.ts pnpm-lock.yaml
git commit -m "build: consume epub-parser dist, drop vite optimizeDeps CJS workaround"
```

---

## Task 3: dev watch 接线验证（concurrently 起 tsup --watch + electron）

确认 `pnpm start` 的 `&& build` + concurrently watch 能起来（dist 先就绪、watch 进程并跑）。

**Files:** 无（仅验证 Task 2 已写入的 `start` 脚本）

- [ ] **Step 1: 验证 prestart build 段独立可跑**

Run:

```bash
pnpm build:packages
```

Expected: PASS，dist 重新生成。

- [ ] **Step 2: dev 冒烟 — 启动 + stale 根治断言（核心验证）**

> 此步需实际启动 Electron，**执行者手动或经 CDP 完成**（参考 memory：dev-cdp-smoke-args-gotcha、playwright-cdp-smoke；dev 吃 `--user-data-dir`）。

手动验证脚本：

1. `pnpm start`（dev 用隔离 user-data：`pnpm start -- --user-data-dir=/tmp/marginalia-smoke-33`）
2. 等应用起、打开任意 epub 书、确认正常阅读（`htmlToText` 路径活跃、无 `named export not found` 控制台报错）。
3. **stale 根治断言**：编辑 `packages/epub-parser/src/content.ts` 的 `htmlToText`（如在返回前加一行无害日志或临时改个空白），保存 → 观察终端 `epub` 通道 tsup 重新 build → 应用 HMR 刷新 → 确认运行时反映新代码（撤回临时改动）。
4. 关闭应用，确认无残留 tsup 僵尸进程（concurrently `-k` 应连带 kill）。

Expected: epub 阅读正常；改 epub-parser 源码经 tsup watch + Vite HMR 即时生效（不再 stale）；无 CJS named-export 报错。

- [ ] **Step 3: （无代码改动，无需 commit）**

---

## Task 4: 忽略 dist 产物（git + lint/format）

dist 是构建产物，不进 git、不参与 lint/format。

**Files:**

- Modify: `.gitignore`
- Modify: `.oxfmtrc.json`
- Modify: `.oxlintrc.json`

- [ ] **Step 1: .gitignore 忽略 packages dist**

在 `.gitignore` 末尾追加:

```
# Workspace package build output (tsup)
packages/*/dist/
```

- [ ] **Step 2: .oxfmtrc.json 忽略 dist**

把 `.oxfmtrc.json` 的 ignorePatterns 改为:

```json
{
  "$schema": "./node_modules/oxfmt/configuration_schema.json",
  "ignorePatterns": ["src/main/db/migrations/**", "packages/*/dist/**"]
}
```

- [ ] **Step 3: .oxlintrc.json 忽略 dist**

在 `.oxlintrc.json` 顶层对象加 `ignorePatterns` 键（紧跟 `$schema` 之后）:

```json
  "ignorePatterns": ["packages/*/dist/**"],
```

- [ ] **Step 4: 验证 dist 不被 git 跟踪、不被 lint/format 扫**

Run:

```bash
git status --short packages/epub-parser/dist 2>/dev/null | head; echo "--- git check-ignore ---"; git check-ignore packages/epub-parser/dist/index.js
pnpm lint
pnpm format:check
```

Expected: `git status` 对 dist 无输出（已忽略）；`git check-ignore` 打印 dist 路径（确认忽略生效）；`pnpm lint` 与 `pnpm format:check` 均 PASS、不报 dist 文件。

- [ ] **Step 5: Commit**

```bash
git add .gitignore .oxfmtrc.json .oxlintrc.json
git commit -m "chore: ignore workspace package dist in git and lint/format"
```

---

## Task 5: 全量验证 + 生产打包冒烟

确认整套改动在生产打包路径也成立（dist 进 `.vite`、产物启动正常）。

**Files:** 无（纯验证）

- [ ] **Step 1: 全链绿**

Run:

```bash
pnpm typecheck && pnpm test && pnpm lint && pnpm format:check
```

Expected: 全部 PASS。

- [ ] **Step 2: 生产打包冒烟**

> 参考 CLAUDE.md「打包期 native 模块 + 迁移路径」与 memory marginalia-release-homebrew-tap：用隔离 user-data 启动产物，验证 epub 导入/阅读。

Run:

```bash
pnpm package
```

Expected: 打包成功（dist 已由 postinstall/`&&` build 备好并被 Rollup 打进 `.vite`）。

手动启动产物冒烟（路径随平台）：启动 `out/` 下产物，传 `--user-data-dir=/tmp/marginalia-pkg-33`，导入并打开一本 epub，确认正常阅读、无 `cannot find module` / `named export` 报错。

- [ ] **Step 3: （无代码改动，无需 commit）**

---

## Task 6: 收尾（合并 + close issue + kanban）

- [ ] **Step 1: 确认无遗留改动 + 分支状态**

Run:

```bash
git status --short
git log --oneline -5
```

- [ ] **Step 2: 用 finishing-a-development-branch skill 合回 main**

按 `superpowers:finishing-a-development-branch` 选项处理（本仓惯例：rebase 保线性，见 memory local-main-rebase-linear-workflow）。

- [ ] **Step 3: close #33 + 挪 kanban Done**

用 `kanban` skill：close issue #33（合并/收尾时），把卡片从 In progress 挪到 Done（option ID `98236657`）。

- [ ] **Step 4: changeset 判定**

本改动为 dev/build 工具链，**对用户不可见 → 不写 changeset**（CLAUDE.md：用户不可见的分支不写）。

---

## 验证策略对照（spec §6）

| spec §6 验证项                     | 对应 task                    |
| ---------------------------------- | ---------------------------- |
| 1. `pnpm typecheck` 绿             | Task 2 Step 5、Task 5 Step 1 |
| 2. `pnpm test` 绿                  | Task 2 Step 6、Task 5 Step 1 |
| 3. dev 冒烟（stale 根治断言）      | Task 3 Step 2                |
| 4. 删 include 无 named-export 回归 | Task 3 Step 2（控制台断言）  |
| 5. `pnpm package` 生产冒烟         | Task 5 Step 2                |
