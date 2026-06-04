# changesets 接入实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 接入 @changesets/cli 做 changelog + 版本管理(应用型半边),补写存量条目,release notes 自动喂给 GitHub Release draft。

**Architecture:** `.changeset/config.json` 开 `privatePackages` 让 private 根包可 version、ignore 两个 workspace 私有包;每分支合并前 `pnpm changeset` 写英文用户向条目;release 前 `changeset version` 聚合进 `CHANGELOG.md` + bump version;新脚本 `scripts/release-notes.mjs` 抽当前版本段经 `gh release edit` 填 draft notes。

**Tech Stack:** @changesets/cli 2.31.0、node 内置模块(脚本零依赖)、gh CLI。

**Spec:** `docs/superpowers/specs/2026-06-04-changesets-changelog-design.md`

**分支:** `chore/changesets`(从 main 切)

**关键背景(执行者必读):**

- pnpm 11;`pnpm add` 后 postinstall 自动重编 better-sqlite3 为 Electron ABI,是预期行为,等它跑完。
- prek pre-commit hook 可能以 "files were modified by this hook" 中止提交:重新 `git add` 被改文件、再跑一次同样 commit 命令。
- 提交信息 Conventional Commits。
- forge 的 PublisherGithub 无 tagPrefix 配置,tag 默认 `v${version}`(现有 `v0.1.0` 印证)。

---

### Task 1: 切分支 + 装包 + init + config

**Files:**

- Create: `.changeset/config.json`、`.changeset/README.md`(init 生成)
- Modify: `package.json`、`pnpm-lock.yaml`(devDependency)

- [ ] **Step 1: 切分支**

```bash
git fetch origin
git status --short        # 应干净
git switch -c chore/changesets main
```

- [ ] **Step 2: 装包 + init**

```bash
pnpm add -D @changesets/cli
pnpm changeset init
ls .changeset/            # 应有 config.json 与 README.md
```

- [ ] **Step 3: 改 config.json**

`.changeset/config.json` 整文件改为:

```json
{
  "$schema": "https://unpkg.com/@changesets/config@3.2.0/schema.json",
  "changelog": "@changesets/cli/changelog",
  "commit": false,
  "fixed": [],
  "linked": [],
  "access": "restricted",
  "baseBranch": "main",
  "updateInternalDependencies": "patch",
  "ignore": ["@marginalia/virtual-docs", "@marginalia/epub-parser"],
  "privatePackages": { "version": true, "tag": true }
}
```

($schema 的版本号以 init 生成的为准,保留原值即可;其余键按上面设置。)

- [ ] **Step 4: 验证 config 合法**

```bash
pnpm changeset status
```

Expected: 输出 "No changesets present"(或同义),**不报 config 校验错误**。若报 ignore 包名不存在,核对 `packages/virtual-docs/package.json` 与 `packages/epub-parser/package.json` 的 `name` 字段,以实际为准修正。

- [ ] **Step 5: 提交**

```bash
git add package.json pnpm-lock.yaml .changeset/
git commit -m "chore: add changesets for changelog and version management"
```

---

### Task 2: 存量补写(changeset 条目 + CHANGELOG + 冗余 tag)

**Files:**

- Create: `CHANGELOG.md`、`.changeset/reader-font-family.md`、`.changeset/first-paint-images.md`、`.changeset/macos-adhoc-sign.md`

- [ ] **Step 1: 手建 CHANGELOG.md**

```md
# marginalia

## 0.1.0

Initial release.
```

(标题 `# marginalia` 与包名一致——`changeset version` 在此标题下方插入新版本段。)

- [ ] **Step 2: 写 3 个存量 changeset**

`.changeset/reader-font-family.md`:

```md
---
"marginalia": minor
---

Switch body font in reading preferences: book default, LXGW WenKai (楷体), serif (Fraunces + Noto Serif SC), or sans (Manrope + Noto Sans SC) — CJK fonts bundled, applies to all books
```

`.changeset/first-paint-images.md`:

```md
---
"marginalia": patch
---

Fix images sometimes failing to appear on first paint when opening a book
```

`.changeset/macos-adhoc-sign.md`:

```md
---
"marginalia": patch
---

Fix macOS Gatekeeper rejecting downloaded builds (ad-hoc code signing)
```

- [ ] **Step 3: 验证 changesets 被识别**

```bash
pnpm changeset status
```

Expected: 列出 marginalia 将 bump 为 **minor**(0.1.0 → 0.2.0),3 个 changeset 全部出现。

- [ ] **Step 4: 删冗余本地 tag + 检查远端**

```bash
git tag -d 0.1.0
git ls-remote --tags origin | grep -c "0.1.0" || true
```

本地 `0.1.0`(指向 e3c4281,早期手打)删除;保留 `v0.1.0`(87b8056,真实 release)。
**若远端也有 `refs/tags/0.1.0`**:不要自行删远端,在报告中注明,由 controller 转交用户决定。

- [ ] **Step 5: 提交**

```bash
git add CHANGELOG.md .changeset/
git commit -m "chore: backfill changesets for unreleased changes since v0.1.0"
```

---

### Task 3: release-notes 脚本 + script 注册

**Files:**

- Create: `scripts/release-notes.mjs`
- Modify: `package.json`(scripts 加一行)

- [ ] **Step 1: 写脚本**

`scripts/release-notes.mjs`:

```js
#!/usr/bin/env node
// 从 CHANGELOG.md 抽取当前 package.json version 的段落,喂给 GitHub Release draft 的 notes。
// 用法: node scripts/release-notes.mjs [--dry-run]
// 防御:版本段缺失/为空、gh 失败(draft 不存在/未认证)都硬退出并透传真实错误;
// 绝不创建 release——forge publish 是唯一创建入口。
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const dryRun = process.argv.includes("--dry-run");
const { version } = JSON.parse(readFileSync("package.json", "utf8"));
const changelog = readFileSync("CHANGELOG.md", "utf8");

// 定位 "## <version>" 标题行,截到下一个 "## " 或 EOF
const lines = changelog.split("\n");
const start = lines.findIndex((l) => l.startsWith(`## ${version}`));
if (start === -1) {
  console.error(
    `CHANGELOG.md has no section for version ${version} — run \`pnpm changeset version\` first`,
  );
  process.exit(1);
}
let end = lines.length;
for (let i = start + 1; i < lines.length; i++) {
  if (lines[i].startsWith("## ")) {
    end = i;
    break;
  }
}
const notes = lines
  .slice(start + 1, end)
  .join("\n")
  .trim();
if (!notes) {
  console.error(`CHANGELOG.md section for ${version} is empty`);
  process.exit(1);
}

if (dryRun) {
  console.log(`--- notes for v${version} ---\n${notes}`);
  process.exit(0);
}

execFileSync("gh", ["release", "edit", `v${version}`, "--notes-file", "-"], {
  input: notes,
  stdio: ["pipe", "inherit", "inherit"],
});
console.log(`Notes updated on release v${version}`);
```

- [ ] **Step 2: 注册 script**

`package.json` 的 scripts 中,`"release"` 行之后加:

```json
"release:notes": "node scripts/release-notes.mjs",
```

- [ ] **Step 3: dry-run 验证(against 0.1.0 段)**

```bash
pnpm release:notes --dry-run
```

Expected:

```
--- notes for v0.1.0 ---
Initial release.
```

- [ ] **Step 4: 提交**

```bash
git add scripts/release-notes.mjs package.json
git commit -m "chore(release): add script to feed changelog section into release notes"
```

---

### Task 4: CLAUDE.md 流程更新 + 试跑 version 验收

**Files:**

- Modify: `CLAUDE.md`(常用命令区 release 行附近)

- [ ] **Step 1: 更新 CLAUDE.md 常用命令**

找到 `pnpm release` 行(约 L18),改为并紧随其后加两行:

```bash
pnpm release        # 发布到 GitHub Release（draft+prerelease；发布前先 pnpm changeset version，发完跑 pnpm release:notes。token 现取自 gh keyring。注意 pnpm publish 是 pnpm 内置命令＝发 npm，勿用）
pnpm changeset      # 合并分支前写一条用户向英文 changelog 条目（finishing 流程一步；用户不可见的分支不写）
pnpm release:notes  # 从 CHANGELOG.md 抽当前版本段填进 GitHub Release draft 的 notes（--dry-run 仅打印不调 gh）
```

- [ ] **Step 2: 试跑 changeset version(验收,之后 revert)**

```bash
pnpm changeset version
```

逐项检查:

```bash
grep '"version"' package.json                  # 应为 "0.2.0"
head -20 CHANGELOG.md                          # 顶部应插入 "## 0.2.0" 段,含 Minor Changes(字体)与 Patch Changes(两条 fix)
ls .changeset/*.md | grep -v README            # 三个存量 changeset 应被消费删除
git status --short packages/                   # workspace 包的 package.json 应无任何变化
pnpm release:notes --dry-run                   # 应打印 0.2.0 段(三条目)
```

- [ ] **Step 3: revert 试跑产物**

```bash
git checkout -- package.json CHANGELOG.md .changeset/
git status --short    # 应只剩 CLAUDE.md 的修改
pnpm changeset status # 应重新列出 3 个 changeset(文件已恢复)
```

(真正的 `changeset version` 留到下次 release 前再跑。)

- [ ] **Step 4: 提交**

```bash
git add CLAUDE.md
git commit -m "docs: document changeset workflow in release commands"
```

---

### 收尾

- 合并回 main 用 superpowers:finishing-a-development-branch(rebase 线性,不要 merge commit)。
- ROADMAP 更新(finishing 一步):设置/产品表加一行「changesets 接入(changelog+版本管理+release notes 脚本)✅」。
- **本分支自身不写 changeset**(工具链接入,用户不可见——按本计划 Task 4 写进 CLAUDE.md 的约定)。

---

## Self-Review 记录

- **Spec 覆盖:** 配置(T1)、流程约定文档化(T4 Step 1)、notes 脚本(T3)、存量补写+tag 清理(T2)、验收三项(T4 Step 2 对应 spec 验收 1/2/3)——全覆盖。
- **占位符:** 无 TBD;config $schema 版本与 ignore 包名均有「以实际为准」的核对步骤而非悬空假设。
- **一致性:** 脚本名 `release-notes.mjs`/script 名 `release:notes` 在 T3/T4/CLAUDE.md 文案间一致;版本预期 0.2.0 与 spec 一致。
