---
name: kanban
description: Marginalia 的需求管理工作流——GitHub Issues + Projects kanban 联动。当用户提出新需求/功能想法/bug 报告（「记个需求」「加到 backlog」「我希望…」「建个 issue」）、开工某个需求、交付完成要关卡挪列、或想盘点/查看需求状态（「看看 backlog」「kanban 上有什么」）时使用本 skill。也适用于：合并分支时检查有无可 close 的 issue、用户口头提到的任何「以后要做」的事项。
---

# 需求管理：Issues + Kanban 工作流

需求的唯一真相源是 **GitHub Issues**，看板视图是 **GitHub Projects kanban**。
`docs/superpowers/ROADMAP.md` 不再记需求（2026-06-07 已全量迁移）——它只留架构决策与交付历史；新需求一律走本工作流。

## 关键常量（实测固化，勿重查）

| 项              | 值                                                                                                      |
| --------------- | ------------------------------------------------------------------------------------------------------- |
| Repo            | `EurFelux/marginalia`                                                                                   |
| Project         | number `1`，owner `EurFelux`（user-level）                                                              |
| Project ID      | `PVT_kwHOA4Ur5c4BZ8B7`                                                                                  |
| Status field ID | `PVTSSF_lAHOA4Ur5c4BZ8B7zhU3Kj4`                                                                        |
| 列 option ID    | Backlog `f75ad846` · Ready `61e4505c` · In progress `47fc9ee4` · In review `df73e18b` · Done `98236657` |

权限：gh token 需要 `project` scope。命令报 `missing required scopes` 时，让用户在输入框跑 `! gh auth refresh -s project --hostname github.com`（交互式，agent 跑不了）。

## 语言与受众约定

仓库面向国际用户：**issue 标题、正文、label、评论一律英文**；与用户的对话照常中文。用户用中文随口描述需求，你负责提炼成结构化英文 issue——这是本工作流最常见的转换动作。

## Label 体系（双轴，建 issue 时两轴都给）

- **类型轴**（选一个）：`bug` · `enhancement`（新能力）· `polish`（已有功能的体验打磨）· `debt`（工程债/重构）· `documentation`
- **领域轴**（可多个）：`area:reader` · `area:pdf` · `area:ai` · `area:library` · `area:settings` · `area:ui` · `area:build`

区分 `enhancement` 和 `polish` 的标准：给用户带来新能力的是 enhancement，让已有能力更顺手的是 polish。

## 四个环节

### ① 记需求（最高频）

用户中文一句话 → 英文 issue → 挂 kanban（自动落 Backlog 列）：

```bash
URL=$(gh issue create --repo EurFelux/marginalia \
  --title "<imperative English title>" \
  --body "<motivation / current behavior / desired direction>

Source: <user request YYYY-MM-DD / spec ref / memory ref>" \
  --label "<type>,<area:...>" | tail -1)
gh project item-add 1 --owner EurFelux --url "$URL" --format json --jq '.id'
```

`item-add` 不带 `--format json` 时成功也零输出——加上 `--jq '.id'` 拿到 item id 即为成功确认，无需再跑 item-list 二次验证。

写好 issue 的要点：

- 标题：简洁祈使句（"Add conversation deletion"，不是 "We should maybe add..."）
- 正文：动机（为什么要做）+ 现状（现在哪里不行）+ 期望方向（不必是完整方案）+ `Source:` 行注明出处
- **相近小项归并**：多个同主题的小点（如一批 PDF 打磨项）合成一个 issue 用 `- [ ]` checklist，别建一堆碎 issue
- 建完把 issue 链接告诉用户

### ② 开工

着手实现某个需求时挪到 In progress：

```bash
ITEM_ID=$(gh project item-list 1 --owner EurFelux --format json \
  --jq '.items[] | select(.content.number == <N>) | .id')
gh project item-edit --id "$ITEM_ID" --project-id PVT_kwHOA4Ur5c4BZ8B7 \
  --field-id PVTSSF_lAHOA4Ur5c4BZ8B7zhU3Kj4 --single-select-option-id 47fc9ee4
```

（其他列同理，换上表的 option ID。）

### ③ 交付

- commit message 末尾加 `closes #N`（push 到 main 后 GitHub 自动关 issue）；一次交付多个需求就写多行 closes
- 部分完成 checklist 型 issue：勾掉对应项（`gh issue edit <N> --body ...` 或留评论），不关 issue
- issue 关闭后把卡片挪到 Done（关 issue 不会自动挪列，按 ② 的命令换 `98236657`）
- 完成后向用户汇报：关了哪些 issue、kanban 状态

### ④ 盘点

```bash
# 看板总览（各列卡片）
gh project item-list 1 --owner EurFelux --format json \
  --jq '.items[] | "\(.status)\t#\(.content.number // "-")\t\(.title)"' | sort
# 按 label 筛 issue
gh issue list --repo EurFelux/marginalia --label "area:pdf" --state open
```

盘点输出给用户时按列分组、中文呈现。

## 时机直觉（何时主动用）

- 用户说「我希望/要是能…就好了」「这个以后做」「记一下」——即使没说 issue/kanban，问一句或直接建卡（小事直接建，建完告知）
- 修 bug 或做功能前，先查有没有对应 issue（盘点命令 + 关键词），有就挪 In progress 并在 commit 里 closes 它
- 合并/发布后，扫一眼 In progress / In review 列有没有该挪 Done 的卡
- 用户报的 bug 当场修掉的，不必建 issue（没有跟踪价值）；修不完或延后的才建
