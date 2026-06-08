# 预构建 epub-parser 为自包含 ESM 产物以根治 Vite deps 缓存翻车设计

日期：2026-06-08
状态：待与用户对齐（2026-06-08 brainstorming），待实现
关联：GitHub Issue #33「Prebuild workspace packages / tame Vite deps caching」（`debt` / `area:build`，P1）。issue 字面提议「把内部工作区包预构建到 dist」，正文要求「**评估**移除临时的 `optimizeDeps.exclude/include` workaround」。经调研，本设计**收敛范围**：只预构建三个内部包中真正需要的那一个（`epub-parser`），不做全量预构建（理由见 §3）。

## 1. 背景与动机

### 1.1 反复 stale 的统一根因

Vite 的依赖预打包（`optimizeDeps`）会把依赖 bundle 进 `.vite/deps` 并缓存。**缓存失效只按「lockfile + config 的 hash」判定，完全无视 pnpm 软链工作区包的源码 mtime**。于是改了 `@marginalia/*` 内部包的源码、lockfile 没变 → Vite 仍供 `.vite/deps` 里的旧 bundle → 运行时是旧代码（stale）。

现状（`vite.renderer.config.ts:35-43`，提交 `a3385e9`）是一个**脆弱平衡**：

```ts
optimizeDeps: {
  // exclude：让内部包源码直供（绕开预打包缓存），改了即时生效、HMR 正常
  exclude: ["@marginalia/virtual-docs", "@marginalia/epub-parser", "@marginalia/pdf-parser"],
  // include：源码直供后，内部包的 CJS 第三方依赖仍需 Vite 转成浏览器 ESM
  include: ["node-html-parser"],
},
```

这个平衡的脆弱点：内部包每新增一个 CJS 传递依赖，就得手动往 `include` 补一条；漏了就在运行时报 `named export not found`（issue 列举的 `node-html-parser named-export mismatch` 即此）。

### 1.2 这是纯 dev 体验债（生产打包不受影响）

`pnpm package` 时，三个内部包的源码会被 Rollup（Forge Vite plugin）一起 bundle 进 `.vite` 产物，**根本不走 `optimizeDeps` 那套缓存**。无头 vitest 走源码树、`pnpm start` 走 dev server——长期掩盖了打包，但缓存坑只在 dev runtime 发作。故本设计的北极星是：**消除「改了内部包源码、dev 运行时还吃旧产物」的反复翻车**。

### 1.3 三个内部包在渲染层的地位完全不同

调研（渲染层 import 面 + 各包依赖性质）得出三个包**不该一刀切**：

| 包             | 渲染层用途                                 | 依赖性质                      | `exclude` 的意义 | 诊断                                   |
| -------------- | ------------------------------------------ | ----------------------------- | ---------------- | -------------------------------------- |
| `virtual-docs` | `VirtualDocs` 组件 + 类型                  | `react-virtuoso`（ESM）       | 源码改了即时 HMR | ✅ 健康，别动                          |
| `epub-parser`  | **仅 `htmlToText` 一个纯函数**             | **`node-html-parser`（CJS）** | 避源码 stale     | ⚠️ **唯一的 CJS `include` 维护负担源** |
| `pdf-parser`   | **完全不 import**（只主进程用，走 Rollup） | —                             | 无               | 🗑️ `exclude` 里是纯噪音                |

关键事实佐证：

- 渲染层只 import 两个包——`epub-parser`（`epub-book.ts:3`，只用 `htmlToText`）与 `virtual-docs`（`EpubReader.tsx` / `epub-selection.ts`）。`pdf-parser` 渲染层零 import（`pdf-book.ts` 直接用 `pdfjs-dist`，不经内部包）。
- `htmlToText` 在渲染层的**唯一**调用点是 `epub-book.ts:88`：`textLengths.set(index, htmlToText(html).length)`，算 section 纯文本长度，且需「与主进程 `readChapterText` 的文本规整口径同源」——故**必须复用同一个共享纯函数**，且输入是渲染层用 epubjs 客户端 render 的 HTML。「把它挪进主进程让渲染层不 import epub-parser」这条釜底抽薪路**走不通**。
- `node-html-parser` 是 CJS（这正是它需要 `include` 转 ESM 的原因）；`react-virtuoso` 在源码直供下无需 `include`（不在现有 include 列表即为证），`virtual-docs` 的 `exclude` 是纯 HMR 收益。

### 1.4 issue 三个翻车点的根因其实分两类

- `htmlToText` / `node-html-parser named-export` → 工作区源码包 + CJS 依赖，**集中在 `epub-parser` 一个包**。本设计根治。
- `stale patched worker after pnpm patch` → **与工作区包无关**：是 `pdfjs-dist`（普通 npm 包 + pnpm patch + 渲染层 `?url` worker 资产缓存）的交互。预构建内部包碰不到它。属低频坑（patch 很少改），经评估**不在本设计范围**（§5）。

## 2. 决策摘要

| 决策点                  | 结论                                                                                                   |
| ----------------------- | ------------------------------------------------------------------------------------------------------ |
| 范围                    | **只预构建 `epub-parser`**，不全量预构建（`virtual-docs`/`pdf-parser` 不预构建）                       |
| 构建工具                | **tsup**（esbuild 底座，出 ESM + `.d.ts`）                                                             |
| 内联策略                | `node-html-parser` + `fflate` + `fast-xml-parser` 全部 `noExternal` → dist **自包含、零外部依赖**      |
| 包消费契约              | `main`/`module`/`types`/`exports` 改指 `dist/`；主进程与渲染层同消费一份 dist                          |
| `exclude`               | **保留** `epub-parser`（仍是软链包，避源码 stale）；**删除** `pdf-parser`（噪音）；`virtual-docs` 不动 |
| `include`               | **整条删除** `node-html-parser`（已内联进自包含 dist）                                                 |
| fixture                 | **不拆子入口**，`makeFixtureEpub` 留主入口（仅依赖 fflate，靠 tree-shaking 出生产 bundle）             |
| test/typecheck 解析     | **全链走 dist**，靠 `pre*` 钩子秒级 build 保新鲜；**不加 src 别名**（避口径分裂 + 别名同步坑）         |
| 子问题 B（pdfjs patch） | **不处理**（低频，经评估排除范围）                                                                     |

## 3. 方案选型：为何是「只预构建 epub-parser」

brainstorming 对比了三个方案，用户选定方案 B：

- **方案 A（零构建，配置防护）**：删 pdf-parser 噪音 + 把 `include` 升级成「扫内部包 CJS 依赖与 include 对账」的校验脚本。改动最小、零 HMR 损失，但只是「**检测**」遗漏，非「**根治**」——运行时仍可能 CJS 翻车。
- **方案 B（本设计，只预构建 epub-parser）**：node-html-parser 在 build 期内联进自包含 ESM dist → 渲染层 import 纯 ESM、`include` 清空、CJS named-export 翻车**从根消失**。代价是 epub-parser 改源码经 watch rebuild 多一跳（但它改动频率很低）。
- **方案 C（全预构建三个包）**：模型最统一，但 `virtual-docs` 丢 React 组件 HMR（且提交 `cf319ad` 明确「NOT React-Compiler-compiled」+ 手动 memo，行为敏感），`pdf-parser` 白预构建（渲染层不用），watch 链变长，**且仍不解决 pdfjs patch stale**。

选 B 的核心理由：**真正需要「稳定产物化」的只有 `epub-parser` 暴露给渲染层的那一小块 CJS 表面**。为 `virtual-docs`/`pdf-parser` 付预构建代价是过度工程。

## 4. 详细设计

### 4.1 关键机制：预构建保留 `exclude`，只清空 `include`（反直觉）

**预构建 ≠ 让 Vite 正常预打包 epub-parser。** 即使 build 成 dist，epub-parser 仍是 pnpm 软链工作区包，dist 文件改了 mtime 也不被 Vite optimizeDeps 缓存跟踪——所以它**仍必须留在 `exclude` 里**。

预构建唯一、也是真正的收益是：**把 `node-html-parser` 这个 CJS 依赖在 build 期内联进自包含 ESM 的 dist**，于是 `exclude` 后 Vite 源码直供 `dist/index.js` 时，**不再有任何外部 CJS import 需要 `include`**。

新的 dev 数据流：

```
改 epub-parser 源码 → tsup --watch 重建 dist/index.js（node-html-parser 已内联）
                   → Vite（exclude 模式直供 dist）监听到变化 → HMR
```

### 4.2 epub-parser 包形态

`packages/epub-parser/package.json`：

```jsonc
{
  "name": "@marginalia/epub-parser",
  "version": "0.0.0",
  "type": "module",
  "main": "./dist/index.js",
  "module": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "exports": {
    ".": { "types": "./dist/index.d.ts", "import": "./dist/index.js" },
  },
  "scripts": {
    "build": "tsup",
    "dev": "tsup --watch",
    "test": "vitest run",
    "typecheck": "tsc --noEmit",
  },
  "dependencies": { "fast-xml-parser": "^5.0.0", "fflate": "^0.8.2", "node-html-parser": "^7.0.1" },
  "devDependencies": { "tsup": "实现时取最新稳定版" },
}
```

`packages/epub-parser/tsup.config.ts`（新增）：

```ts
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["src/index.ts"],
  format: ["esm"],
  dts: true,
  clean: true,
  // 内联所有运行时依赖，dist 自包含、零外部 import——这是清空 vite include 的前提
  noExternal: ["node-html-parser", "fflate", "fast-xml-parser"],
});
```

- `dts: true` 由 src 生成 `dist/index.d.ts`，覆盖现有全部导出（`ParsedEpub`/`SpineItem`/`TocNode`/`ChapterTextSlice`/`ReadOptions` + 各函数）；主进程 `import { type TocNode }` 等仍成立。
- `dependencies` 字段保留（tsup 解析需要、装包需要）；运行时 dist 自包含，主进程 Rollup bundle dist 时这些依赖已在 dist 内，结果与现状（Rollup 顺着 src import 打包）等价。
- 包自身单元测试（`packages/epub-parser/src/**/*.test.ts`）仍由 vitest **直接测 src 文件**（不走包解析），不受预构建影响。

### 4.3 vite.renderer.config.ts 变化

```diff
  optimizeDeps: {
-   exclude: ["@marginalia/virtual-docs", "@marginalia/epub-parser", "@marginalia/pdf-parser"],
+   exclude: ["@marginalia/virtual-docs", "@marginalia/epub-parser"],
-   // epub-parser 源码直供后，其 CJS 第三方依赖仍需要由 Vite 转成浏览器可消费的 ESM。
-   include: ["node-html-parser"],
  },
```

并更新 `exclude` 上方注释，记录「epub-parser 现为自包含 ESM 的源码直供包，仍 exclude 以避软链 stale；node-html-parser 已内联，无需 include」。

`vite.main.config.ts` / `vite.preload.config.ts` **不改**（主进程 Rollup 照常 bundle dist，与 bundle src 等价；preload 不 import 这些包）。

### 4.4 dev / CI 接线（根 package.json）

```jsonc
{
  "scripts": {
    "build:packages": "pnpm --filter @marginalia/epub-parser build",
    "prestart": "pnpm build:packages",
    "start": "concurrently -k \"pnpm --filter @marginalia/epub-parser dev\" \"electron-forge start\"",
    "pretypecheck": "pnpm build:packages",
    "typecheck": "tsc --noEmit",
    "pretest": "pnpm build:packages",
    "test": "ELECTRON_RUN_AS_NODE=1 electron node_modules/vitest/vitest.mjs run",
    "postinstall": "pnpm build:packages && pnpm db:rebuild:electron",
  },
}
```

- **postinstall**：在现有 `db:rebuild:electron` 前先 build epub-parser，fresh clone/install 后 dist 即就绪（覆盖 typecheck/test/package 的首次需要）。pnpm 在 dep build 之后跑根 postinstall，tsup 与依赖均已可用。
- **prestart + start**：`prestart` 先 build 一次（保证 `electron-forge start` 启动时 Vite 能立即解析到 dist）；`start` 用 `concurrently -k` 并跑 `tsup --watch`（持续增量 rebuild）+ `electron-forge start`，任一退出连带 kill。
- **pretypecheck / pretest**：各跑一次秒级 esbuild build 保 dist 新鲜——换取「全链走 dist 单一真相、零别名、零 stale」，无需在 `tsconfig.json` / `vitest.config.ts` 加 `@marginalia/epub-parser → src` 别名（规避 CLAUDE.md 点名的「别名四处同步」坑）。
- 新增 devDependencies：`tsup` 装在 **`epub-parser` 包**（`--filter` 在该包跑 build，见 §4.2）；`concurrently` 装在 **根包**（根 `start` 脚本用）。
- `.gitignore` 增加 `packages/epub-parser/dist/`；确认 oxlint / oxfmt 忽略该 dist（产物不参与 lint/format）。
- `forge.config.ts` **不改**：dist 由 postinstall 备好，Forge Rollup 照常打进 `.vite`。

### 4.5 fixture 留主入口

`makeFixtureEpub` 仍从 `src/index.ts` 导出（现状）。它仅依赖 `fflate`（生产已用，无 `pdf-parser` 的 pdf-lib 那种 UMD/bundle 风险），生产 bundle 中作为未引用代码由 tree-shaking 消除。8+ 处测试的 `import { makeFixtureEpub } from "@marginalia/epub-parser"` **无需改动**。

## 5. 不在本设计范围

- **子问题 B（pdfjs-dist patch 后 worker stale）**：低频坑（`patches/pdfjs-dist.patch` 很少改），与工作区包正交，经评估不做特别处理；若未来频繁发作，可单列升级（候选措施：`optimizeDeps.exclude` pdfjs-dist，或 `dev:clean` 清 `.vite/deps` 流程纪律）。
- **预构建 `virtual-docs` / `pdf-parser`**：不做。`virtual-docs` 保留源码直供（健康 HMR）；`pdf-parser` 仅从渲染层 `exclude` 删除（噪音），不改其包形态。
- **test/typecheck 经别名吃 src**：不做（见 §4.4 理由）。

## 6. 验证策略

1. `pnpm typecheck` 绿——`dist/index.d.ts` 类型正确，主进程 `TocNode` 等仍可 import。
2. `pnpm test` 绿——主 app 经 dist 消费 epub-parser，全测试通过；epub-parser 自测仍走 src。
3. **dev 冒烟（stale 根治的核心断言）**：`pnpm start` 后改 epub-parser src（如微调 `htmlToText`），确认 tsup watch rebuild + Vite HMR 生效、运行时拿到**新代码**（不再 stale）。
4. **CJS 回归断言**：删 `include` 后渲染层 `htmlToText` 仍正常工作，**无 `named export not found`**；epub 章节文本长度（`textLengthAtIndex`）与主进程口径一致。
5. `pnpm package` 生产冒烟：产物启动正常、epub 导入/阅读正常（dist 正确进 `.vite`），用 `--user-data-dir=/tmp/<x>` 隔离。

## 7. 风险与回滚

| 风险                                                               | 缓解                                                                     |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------ |
| tsup `dts` 生成的 `.d.ts` 与 src 类型边缘不等价                    | §6 验证项 1（typecheck）全量验证                                         |
| 内联后 `dist/index.js` 体积偏大，dev exclude 直供大文件致 HMR 略慢 | 可接受（epub-parser 改动频率低）；必要时改 `splitting`/external 局部依赖 |
| `concurrently` 进程管理（start 退出残留 tsup watch）               | `-k`（kill-others）；冒烟确认无僵尸进程                                  |
| pre 钩子每次 build 增加 typecheck/test 启动开销                    | esbuild 增量 build <1s，可接受                                           |

**回滚成本低（配置级）**：还原 `exports`/`main`/`types` 指回 `src/index.ts`、恢复 `vite.renderer.config.ts` 的 `include` + `pdf-parser` exclude、移除构建脚本与 tsup 配置即可。
