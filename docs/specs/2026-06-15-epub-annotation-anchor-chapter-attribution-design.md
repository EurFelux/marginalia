# ePub 标注 anchor 级章节归属设计

- 日期：2026-06-15
- Issue：待建（接续 href 级修复）
- 状态：已与用户对齐定稿
- 前序：`2026-06-15-epub-annotation-chapter-attribution-design.md`（href 级修复，已实现）

## 背景与动机

href 级修复（`chapterIdAtCfi` 用 spine href + `chapterIdByHref`）对**多 spine 书**（每章独立文件）完全有效。但对**单文件 + 锚点切章**的书（整本书在一个 spine 文件、TOC 用 `#fragment` 锚点切章，如「早起的奇迹」：61 章共享 1–2 个 href、60 章带 `fileposNNNN` anchor），所有章共享同一 href → `chapterIdByHref` 歧义返回 null → 标注**不显示章节**。本设计补上 anchor 级细分，让这类书的标注也归属到正确锚点章。

## 已取证的技术约束

- `EpubCFI.compare(a, b)` 是标准 comparator（-1/0/1），按文档元素顺序比较同 section 内位置；标注的 range CFI 与锚点的 point CFI 可比。→ 归属 = 「最后一个边界 CFI ≤ 标注 CFI」（与 PDF `chapterIdAtPage` 同构）。
- 锚点边界 CFI 必须用 DOM 生成：渲染 spine section（`loadSection` → `s.document`）→ `getElementById(anchor)` → `cfiFromElement`（`epub-book.ts` 已有 `cfiFromElement`）。
- 仅「同 href 多锚点章」的标注需要 anchor 细分；多 spine 书 href 级已唯一，零成本跳过。

## 设计

### ① `chapterIdAtCfi` 升级为两级归属

`src/renderer/reader/chapter-id-at-cfi.ts`，签名增可选末参（第一轮调用/测试不传仍走 href 级，零破坏）：

```ts
export interface AnchorBoundary {
  chapterId: string;
  cfi: string;
}

export function chapterIdAtCfi(
  chapters: ChapterRefDto[],
  spineHrefs: string[],
  cfi: string,
  anchorBoundaries: AnchorBoundary[] = [],
): string | null;
```

逻辑：

1. `spinePos = new EpubCFI(cfi).spinePos`（无效 CFI try/catch → null）；`href = spineHrefs[spinePos]`（越界 → null）。
2. `matches = chaptersMatchingHref(chapters, href)`（见 ②）。
3. `matches.length === 0` → null；`=== 1` → `matches[0].id`（多 spine 书走这）。
4. `matches.length > 1`（共享 href 的锚点章）→ 在 `anchorBoundaries` 中筛出这些章的边界（保持按 cfi 升序），用 `EpubCFI.compare` 取**最后一个 `compare(boundary.cfi, cfi) <= 0`** 的 `chapterId`。
5. 该 href 无可用边界（预计算未就绪/失败/无 anchor）→ null（退化到现状，宁可不显示不错章）。

### ② 复用重构：`chaptersMatchingHref`

`src/renderer/reader/chapter-id-by-href.ts` 抽出：

```ts
export function chaptersMatchingHref(chapters: ChapterRefDto[], href: string): ChapterRefDto[];
// exact（去 fragment）命中则返回该项；否则 basename 命中的全部
```

`chapterIdByHref` 改为 `const m = chaptersMatchingHref(...); return m.length === 1 ? m[0].id : null;`（行为不变）。`chapterIdAtCfi` 复用它拿 matches，消除重复的 href 匹配逻辑。

### ③ `epub-book.ts` 扩展：生成锚点边界 CFI

`EpubBook` 接口新增：

```ts
/** 确保 section 已渲染，为其中 anchorId 元素生成 point CFI；失败返回 null。 */
anchorCfi: (index: number, anchorId: string) => Promise<string | null>;
```

实现：`sectionAt(index)` → 若 `s.document` 未就绪先 `loadSection(index)`（触发 render）→ `s.document.getElementById(anchorId)` → `new EpubCFI(el, s.cfiBase, ANNO_IGNORE_CLASS).toString()`；任一步失败 catch → null。

### ④ `epub-session.tsx`：开书后异步预计算 `anchorBoundaries`

Provider 内 `qk.chapters(bookId)` query（RQ 去重，不增 IPC）。book 就绪后异步 effect：

1. 按 basename 分组 chapters，挑出 size > 1 且含 anchor 的组（= 共享 href 的锚点章）。
2. 每组经 `book.indexOfHref(href)` 定位 spine index；逐 anchor 调 `book.anchorCfi(index, anchor)`。
3. 收集 `{ chapterId, cfi }`，按 `EpubCFI.compare` 升序排序，`setAnchorBoundaries(...)`。
4. `alive` 守卫防换书竞态；整体 try/catch，失败 `log.warn` 并退化（boundaries 留空）。

context（`EpubSession`）新增字段 `anchorBoundaries: AnchorBoundary[]`（默认 `[]`）。

### ⑤ `AnnotationsList.tsx` 接线

从 `useEpubSession()` 多取 `anchorBoundaries`，传给 `chapterIdAtCfi` 第 4 参。其余不变。预计算完成前 `anchorBoundaries=[]` → 退化 href 级（共享 href 书暂显示空），完成后重渲染显示正确锚点章。

## 范围外

- 不改 DB / 主进程 / 不持久化边界 CFI（每次开书异步重算）。
- 不为「非共享 href」的章生成边界（href 级已唯一，无需）。
- 不处理跨 spine 的全局统一边界表（按 href 分组细分即可）。

## 测试

- `chaptersMatchingHref`：exact 命中、basename 兜底、多命中返回列表、无命中空。
- `chapterIdAtCfi` anchor 细分：多章共享 href + 边界 CFI → 正确归属；边界为空 → null 退化；`EpubCFI.compare` 边界判定（测试运行时可用，已验证）。
- `epub-book.anchorCfi` + 预计算：无单测（DOM/epubjs），靠 `pnpm typecheck` + CDP 冒烟。
- 冒烟：用一本「共享 href 锚点章 + 文件在库」的书（或临时导入「早起的奇迹」）；标注章节应显示正确锚点章，且与跳转后当前章一致；多 spine 书（被讨厌的勇气）不回归。

## 涉及文件

| 文件                                                 | 改动                                              |
| ---------------------------------------------------- | ------------------------------------------------- |
| `src/renderer/reader/chapter-id-by-href.ts` (+ test) | 抽 `chaptersMatchingHref`，`chapterIdByHref` 复用 |
| `src/renderer/reader/chapter-id-at-cfi.ts` (+ test)  | 升级两级归属 + `AnchorBoundary` 类型              |
| `src/renderer/reader/epub-book.ts`                   | 新增 `anchorCfi`                                  |
| `src/renderer/reader/epub-session.tsx`               | 预计算 `anchorBoundaries` + context 字段          |
| `src/renderer/reader/AnnotationsList.tsx`            | 传 `anchorBoundaries`                             |
