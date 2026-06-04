# GitHub Release 发布流程设计

- **日期**：2026-06-04
- **状态**：已批准
- **目标**：建立可重复的本地发布流程——一条命令把 `pnpm make` 产物（macOS dmg + zip）发布到 GitHub Release。

## 背景与现状

- `forge.config.ts` 已配置 makers（DMG、ZIP[darwin] 等），`pnpm make` 在 macOS 上可正常产出 dmg/zip；但 **没有 `publishers` 配置**，`@electron-forge/publisher-github` 未安装，`electron-forge publish` 当前不可用。
- 仓库为 `EurFelux/marginalia`，尚无任何 release；`gh` CLI 已登录（token 含 `repo` scope）。
- `package.json` 的 `version` 为 `1.0.0`（Forge 模板默认值），与项目实际所处的 MVP 阶段不符。
- 产物**未正式签名/公证**（backlog 已记录）：下载者打开 dmg 会被 Gatekeeper 拦截，需右键打开或 `xattr -cr`。

## 决策

| 决策点       | 结论                                           | 理由                                                                                                                                                                                        |
| ------------ | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 发布方式     | Forge 官方 `@electron-forge/publisher-github`  | 与 Forge 流水线原生集成（publish 自动先 make），tag/版本号自动取自 `package.json`，维护成本最低。备选的 `gh release create` 脚本需自维护 glob 与版本提取；CI 自动发布留待签名解决后再考虑。 |
| 首发版本号   | `1.0.0` → `0.1.0`                              | 符合 semver 惯例：0.x 表示开发中、未稳定；MVP 阶段更诚实，给 1.0 留出里程碑意义。                                                                                                           |
| Release 形态 | `draft: true` + `prerelease: true`             | 草稿先上传、网页补 notes 后手动发布，防手滑；0.x 阶段一律标 prerelease。                                                                                                                    |
| token 来源   | `GITHUB_TOKEN=$(gh auth token)` 包在 script 里 | 每次从 gh keyring 现取，token 不落盘、零额外配置。                                                                                                                                          |

## 改动清单

### 1. 依赖

- `pnpm add -D @electron-forge/publisher-github`（与现有 Forge 版本同系）。
- 装包后 `postinstall: pnpm db:rebuild:electron` 会自动把 better-sqlite3 翻回 Electron ABI，无需手动处理；仅当 postinstall 异常未跑时手动补。

### 2. `forge.config.ts`

新增 `publishers` 配置：

```ts
import { PublisherGithub } from "@electron-forge/publisher-github";
// ...
publishers: [
  new PublisherGithub({
    repository: { owner: "EurFelux", name: "marginalia" },
    prerelease: true,
    draft: true,
  }),
],
```

### 3. `package.json`

- `version`: `1.0.0` → `0.1.0`。
- 新增 script：`"release": "GITHUB_TOKEN=$(gh auth token) electron-forge publish"`。
- **删除**现有 `"publish"` script，并新增顶层 `"private": true`。双保险防 `pnpm publish`（pnpm **内置命令**，优先于同名 script）误把整个 app 发到 npm registry。

### 4. 文档

- CLAUDE.md 常用命令表：`pnpm publish` 行改为 `pnpm release   # 发布到 GitHub Release（draft）`。
- ROADMAP 按惯例在合并时更新。

## 发布操作手册

publisher 创建 release 时，tag `v<version>` 指向 **origin 默认分支的 HEAD**。本仓库工作流是「本地 main 攒一波再批量推」，origin/main 可能落后，因此发布前必须先推：

1. 确认要发布的代码已合入本地 `main` 并推到 origin（`git push origin main`）。
2. 在 main 上跑 `pnpm release`（自动 make → 上传 dmg + zip 到 draft release）。
3. 去 GitHub release 页面：点 Generate release notes、补一段 Gatekeeper 说明（未签名，需右键打开或 `xattr -cr`），再手动 publish。

## 验证方式

配置类改动无单元测试，以真实发布链路为验收：

1. `pnpm release -- --dry-run`：验证 make 产物收集无误（不上传）。
2. 真跑 `pnpm release`：确认 GitHub 出现 `v0.1.0` draft release，assets 含 `.dmg` 与 `.zip`。
3. 常规门禁：`pnpm typecheck`、`pnpm lint`、`pnpm test` 保持绿。

## 非目标

- 代码签名 / 公证（留在 backlog，本次仅在 release notes 中写明绕过方法）。
- Windows / Linux 产物（当前仅 macOS 构建链路验证过）。
- CI 自动发布（待签名与多平台需求明确后另行设计）。
- 应用内自动更新（ZIP 作为未来 autoUpdater 源保留，本次不接线）。
