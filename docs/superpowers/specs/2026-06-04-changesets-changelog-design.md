# changesets 接入设计(changelog + 版本管理)

2026-06-04 · 状态:设计对话已确认,spec 待评审

## 背景与目标

项目目前无 CHANGELOG,GitHub Release 的 notes 靠「draft 上传后网页手动补」(见 `forge.config.ts` publisher 注释)。引入 [changesets](https://github.com/changesets/changesets) 把 changelog 条目的写作时机挪到每个分支合并时,release 时聚合成 `CHANGELOG.md` 并自动喂给 Release draft 的 notes。

marginalia 是应用型 repo(非 npm 库),只用 changesets 的「版本 bump + changelog 聚合」半边,不碰 npm publish。

**需求决策**(brainstorming 已确认):

- changelog 语言/受众:**英文、用户向**(技术细节留在 commit/spec)
- 起点:**补未发布部分**——0.1.0 在 CHANGELOG 留一行 `Initial release.`;v0.1.0 之后已合并未发布的内容补写 changeset
- notes 接线:**脚本自动喂**(`gh release edit`),draft 仍手动 publish 把关
- 工具选型:@changesets/cli 标准接入(弃 git-cliff/conventional-changelog——commit 是开发者向口吻,生成不出用户向英文;弃手写 Keep-a-Changelog——版本 bump 手动、聚合靠自觉)

## 工具与配置

`pnpm add -D @changesets/cli` + `changeset init`,`.changeset/config.json` 关键项:

```jsonc
{
  "baseBranch": "main",
  // 根包 package.json 是 private:true,默认会被 changesets 跳过,必须显式开
  "privatePackages": { "version": true, "tag": true },
  // workspace 私有包不参与版本管理(它们随 app 整体演进,无独立版本语义)
  "ignore": ["@marginalia/virtual-docs", "@marginalia/epub-parser"],
  // 默认生成器,纯文本条目(changelog-github 需查 PR 信息,本地合并流无 PR,不适用)
  "changelog": "@changesets/cli/changelog",
}
```

`packages/ui-prototype` 不在 pnpm workspace(独立 lock),天然不受影响。

## 流程约定

- **写作时机**:每个分支走 finishing 流程合并前,`pnpm changeset` 写一条**英文、用户向**描述;纯 docs/重构/CI 等用户不可见的分支**不写**。
- **版本语义**(0.x 阶段):新功能 = `minor`,修复/杂项 = `patch`,不用 `major`。
- **release 流程**变为:

  ```
  pnpm changeset version   # 聚合 .changeset/*.md → CHANGELOG.md + bump package.json version
  git add -A && git commit # version commit
  pnpm release             # forge publish:打 tag、传 draft(现状不变)
  pnpm release:notes       # 新脚本:CHANGELOG 当前版本段 → gh release edit 填 notes
  # 网页核对 → 手动 publish draft → bump homebrew tap(现状不变)
  ```

- `CLAUDE.md` 常用命令与 finishing 约定同步补这两步(`changeset` 写作时机、`release:notes`)。

## notes 脚本

`scripts/release-notes.mjs`(node 内置模块,零依赖):

1. 读 `package.json` 的 `version`,在 `CHANGELOG.md` 中定位 `## <version>` 段落(到下一个 `## ` 或 EOF 为止)。
2. 段落经 stdin 喂给 `gh release edit v<version> --notes-file -`。
3. 防御:CHANGELOG 中找不到该版本段 → 报错退出;`gh release edit` 失败(draft 不存在等)→ 透传 gh 的真实错误退出。**不创建 release**——forge publish 是唯一创建入口。
4. 支持 `--dry-run`:只打印抽出的段落,不调 gh(本地验证用)。

`package.json` 增加 script:`"release:notes": "node scripts/release-notes.mjs"`。

## 存量补写(一次性)

- `CHANGELOG.md`:手建,0.1.0 段只写 `Initial release.`(changeset version 会在其上方插入新版本段)。
- 补 3 个 changeset 文件(对应 v0.1.0(87b8056)之后未发布的用户可见变更):

  | bump  | 内容(英文、用户向)                                                                                                                                                                      |
  | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
  | minor | Switch body font in reading preferences: book default, LXGW WenKai (楷体), serif (Fraunces + Noto Serif SC), or sans (Manrope + Noto Sans SC) — CJK fonts bundled, applies to all books |
  | patch | Fix images sometimes failing to appear on first paint when opening a book                                                                                                               |
  | patch | Fix macOS Gatekeeper rejecting downloaded builds (ad-hoc code signing)                                                                                                                  |

  (第三条若 0.1.0 资产当时已替换重发,用户评审时可删。)

- 删除冗余本地 tag `0.1.0`(e3c4281,早期手打;保留真实 release 的 `v0.1.0`=87b8056)。

预期下个版本号:**0.2.0**(存在 minor)。

## 测试与验收

工具链配置无单测,验收 = 实跑:

1. 临时试跑 `pnpm changeset version`,检查:`package.json` bump 到 0.2.0、`CHANGELOG.md` 聚合出 0.2.0 段(三条目)、`.changeset/*.md` 被消费删除;检查后 **revert 试跑产物**(git checkout),保留配置与 changeset 文件——真正的 version 留到下次 release 时跑。
2. `pnpm release:notes --dry-run` 验证段落抽取正确(against 试跑期的 CHANGELOG;revert 前验)。
3. workspace 包不受影响:试跑后 `git status` 确认 `packages/*/package.json` 无 version 变化。
