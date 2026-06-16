---
name: release
description: Marginalia 的发版工作流——从 changeset 到 GitHub Release 再到 bump homebrew tap 的端到端流程。当用户说「发版」「发布」「出一版」「发个 X.Y.Z」「release」「bump version」「更新 tap」「该发布了」，或合并完一批改动准备分发时使用本 skill。涵盖顺序敏感的步骤（push main 必须先于 publish）与全部已知致命坑（adhoc 签名、cookie fuse、dmg 文件名陷阱、sha256 交叉核验）。即便用户只说「发个新版本」没点名步骤，也走本流程。
---

# Marginalia 发版流程

发版＝把 main 上攒的改动 → bump 版本 → 发 GitHub Release（dmg/zip）→ bump homebrew tap，让用户 `brew upgrade` 拿到。

app 仅 **ad-hoc 签名**（无 Apple Developer 证书，公证留 backlog），浏览器下载必触发 Gatekeeper；靠 brew cask 的 `postflight`（`xattr -cr` 清 quarantine）实现安装即开零弹窗——所以**每次发版都要 bump tap，否则不闭环**。

整条链有几个**顺序敏感**的点，错了会留下 broken release / 源码 tag 错位 / 启动即崩。严格按下面顺序走。

## 总览（务必按此顺序）

1. `pnpm changeset` — 写 changelog 条目（合并分支时就该写）
2. `pnpm changeset version` → `pnpm format` → commit `chore: release X.Y.Z`
3. （涉打包/native/迁移/签名改动时）`pnpm package` 真启动冒烟
4. **`git push origin main` 先**，确认 origin/main 已含 release commit
5. `pnpm release` → `pnpm release:notes`
6. bump homebrew tap（sha256 交叉核验后 push）

## 关键常量（实测固化，勿重查）

| 项             | 值                                                                                        |
| -------------- | ----------------------------------------------------------------------------------------- |
| 主仓库         | `EurFelux/marginalia`                                                                     |
| tap 仓库       | `EurFelux/homebrew-tap`（**public**，符合 `brew tap` 惯例命名）                           |
| tap 本地 clone | `~/dev/homebrew-tap`                                                                      |
| cask 文件      | `~/dev/homebrew-tap/Casks/marginalia.rb`（改 `version` + `sha256`）                       |
| dmg 产物       | `out/make/**/marginalia-<X.Y.Z>-arm64.dmg`（**用确切文件名**，见 ⑥ 坑）                   |
| release 模式   | 自 543c120 起直接发 Latest（`forge.config.ts` PublisherGithub `draft/prerelease: false`） |

## 逐步

### ① changeset

合并分支前写一条**用户向英文** changelog 条目（用户不可见的分支不写）：

```bash
pnpm changeset
```

### ② version bump + 提交

```bash
pnpm changeset version   # bump package.json + 生成/更新 CHANGELOG.md
pnpm format              # ⚠️ 必须：见下方 why
git add -A
git commit -m "chore: release X.Y.Z"
```

> **为什么先 `pnpm format`**：oxfmt 也格式化 markdown，changeset 生成的 `CHANGELOG.md` 不合 oxfmt 风格；pre-commit 的 format 钩子是 `oxfmt --check`（**check-only、不自动修**，与 lint:fix 不同），会拦下 `chore: release X.Y.Z` 提交。先 format 重排、再 add、再 commit。

### ③ 打包冒烟（涉打包/native/迁移/签名改动时必做）

签名结构有效 ≠ 能跑。纯业务改动可略；只要碰过 `forge.config.ts`、native 模块、DB 迁移、打包配置，就必须真启动验证：

```bash
pnpm package
out/*-darwin-*/marginalia.app/Contents/MacOS/marginalia --user-data-dir=/tmp/rel-smoke &
pgrep -f rel-smoke                               # 进程存活
# 日志无 `loadFile failed`（首载断言）—— 看终端输出或 userData 日志
sqlite3 /tmp/rel-smoke/marginalia.db ".tables"   # 应列出全表
```

> 崩溃看 `~/Library/Logs/DiagnosticReports/marginalia-*.ips` 的 termination reasons。验证完 `pkill -f rel-smoke`。

### ④ push main —— 顺序致命，必须先于 publish

```bash
git push origin main
git ls-remote origin refs/heads/main   # 确认远端 HEAD 已含 release commit
```

> **为什么**：GitHub 创建尚不存在的 tag 时，按**默认分支远端 HEAD（origin/main）**打，不是本地 HEAD。没 push 就 publish，`vX.Y.Z` tag 会落在旧 commit 上 → Release 页「Source code」快照不含本次代码（dmg/zip 二进制正确，但源码 tag 错位）。`forge.config.ts` 的 PublisherGithub 处也留了同款注释。
> **补救**：`git push origin main` + `git tag -f -a vX.Y.Z <release-commit> -m vX.Y.Z`（本地 git 默认 annotated，省 `-m` 报 `no tag message`）+ `git push -f origin vX.Y.Z`（force-push tag 会被 auto-mode 安全策略拦，需用户授权）。

### ⑤ 发 Release + 填 notes

```bash
pnpm release        # = GITHUB_TOKEN=$(gh auth token) electron-forge publish，打包 + 发布到 GitHub Release（直接 Latest）
pnpm release:notes  # 从 CHANGELOG.md 抽当前版本段填进 Release notes（--dry-run 仅打印不调 gh）
```

> ⚠️ 是 `pnpm release` **不是** `pnpm publish`——后者是 pnpm 内置命令＝发 npm 包，勿用。
> **secondary rate limit**：electron-forge 连传两个 ~169M asset（zip→dmg）易撞 GitHub 400「Whoa there」致 publish 失败。直接发布（非 draft）中途挂会留「已公开但缺 asset 的 broken Latest」——补救只需 `gh release upload vX.Y.Z <缺失文件>` 补缺的那个，**不必重跑打包链**。

### ⑥ bump homebrew tap

```bash
# 算新 dmg 的 sha256 —— ⚠️ 填确切版本号，别用 *.dmg | head
DMG=$(find out/make -name 'marginalia-X.Y.Z-arm64.dmg')
shasum -a 256 "$DMG"
# 交叉核验：下载 GitHub asset 比对两边 sha256 一致再 bump
gh release download vX.Y.Z --repo EurFelux/marginalia --pattern '*.dmg' -D /tmp/rel-verify
shasum -a 256 /tmp/rel-verify/*.dmg
# 一致后改 ~/dev/homebrew-tap/Casks/marginalia.rb 的 version + sha256
cd ~/dev/homebrew-tap && git add Casks/marginalia.rb && git commit -m "marginalia X.Y.Z" && git push
```

> **dmg 文件名陷阱**：`out/make` 不自动清理、积累多版本 dmg，`find … | head -1` / `*.dmg` 会拿到旧版本（实录差点用成上个版本的哈希）。务必锚定确切文件名 `marginalia-<新版本>-arm64.dmg`，并用 `gh release download` 交叉核验。
> **tap commit 风格**：简洁单行 `marginalia X.Y.Z`，**不加 Co-Authored-By**（私人 CLAUDE.md 的 co-author 约束仅对 marginalia 项目生效，tap 按自身规范）。

## 已知坑（`forge.config.ts` 配置固化，勿"优化")

这些是反复踩出来的，**别动**：

- **adhoc 签名四件套**（osxSign）：`identity:"-"` + `identityValidation:false` + `preAutoEntitlements:false` + `optionsForFile:()=>({hardenedRuntime:false})`，缺一启动即崩——hardened runtime 的 library validation 要求同 Team ID，adhoc 无 TeamID → dyld 拒载 Electron Framework。另 `continueOnError:false` 防 packager 静默吞签名失败（默认 true）。
- **`EnableCookieEncryption` fuse 必须 `false`**：开启时 Chromium 启动即初始化 Safe Storage（macOS 钥匙串），ad-hoc 每次构建签名都变 → 每个新版**首启弹钥匙串密码 + 首次 loadFile 以 ERR_FAILED 白屏**（重开即好、重载即好——「首载 100% 失败、重载 100% 成功」就是它）。本 app key 明文落库、无钥匙串需求。读产物 fuse 实况：`node -e "require('@electron/fuses').getCurrentFuseWire('<app 路径>')"`（索引 1=CookieEncryption，`'0'`=关）。

## 升级验证（发版后在本机验真，可选但推荐）

- `brew upgrade --cask` **不杀正在运行的旧实例**：替换 `/Applications` 后旧进程继续跑旧代码，`open` 因 Electron single-instance 锁只**聚焦旧进程**（表现为「升级后行为还是旧版 / 迁移没跑」）。先 `pkill -f "/Applications/marginalia.app"` 退旧实例再启动验证。
- **涉 DB 迁移的版本**：升级前先备份 `sqlite3 <prod>/marginalia.db ".backup '<prod>/marginalia-vXYZ-backup.db'"`（`cp` 不含 WAL 未合并数据，必须用 `.backup`）；升级后查 `__drizzle_migrations` 行数对齐迁移目录数。

## 时机直觉

- 用户说「发版」「出一版」「发个 X.Y.Z」「更新 tap」「该发布了」——走本流程；拿不准版本号就先看 `git log` 与未发布的 changeset。
- 全流程最致命的一条：**`git push origin main` 必须先于 `pnpm release`**。别的步骤错了能补，这条错了源码 tag 就错位。
- **每次发版必做 ⑥ tap bump**，否则用户 `brew upgrade` 拿不到新版——发版不算闭环。
