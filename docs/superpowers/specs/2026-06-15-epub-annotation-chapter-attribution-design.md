# ePub 标注章节归属修复 + book 实例提升设计

- 日期：2026-06-15
- Issue：待建（bug 修复 + 架构重构）
- 状态：已与用户对齐定稿

## 背景与动机

ePub 标注在侧栏（标注 tab）显示的「所属章节」与选段实际所在章节不一致——多数真实电子书会系统性错章，或显示为空。PDF 标注不受影响。

## 根因分析（代码级取证）

侧栏 `AnnotationsList` 推断 ePub 标注章节时，用 **CFI 的 `spinePos`** 去匹配 **`chapter.orderIndex`**，但两者不是同一个基准：

1. **入库** `src/main/library/repository.ts:40-44, 102-108`：`chapterSeedsFor` **优先用 TOC 条目**（`chapterSeedsFromToc` 扁平化 TOC 树），再 `forEach((seed, index) => orderIndex: index)`。所以 `orderIndex` = **扁平 TOC 条目数组的下标**——会跳过所有不在 TOC 的 spine 项（封面/版权/插页），嵌套小节还各占一个下标。只有「书完全无 TOC」才回退成 spine 顺序。
2. **选区 CFI** `src/renderer/reader/EpubReader.tsx:197`：`book.cfiFromRange(e.index, e.range)` 生成的 CFI，其 `spinePos` = **epubjs spine 物理位置**（含封面/版权页在内的全部 spine 项）。
3. **展示** `src/renderer/reader/AnnotationsList.tsx:62-73`：`spineOf(locator)` 取 CFI 的 `spinePos`，再 `chapters.find((c) => c.orderIndex === sp)`。

只要 spine 前面有非 TOC 项（封面页几乎必有），`spinePos` 就整体偏移，`find` 撞到错误章节或匹配不到。

**佐证**：同代码库内「当前章追踪」（`EpubReader.tsx:226-227`）用的是正确的 **href 匹配**（`book.hrefAtIndex` → `chapterIdByHref`，含 basename 兜底处理 epubjs↔parser 前缀差异）；PDF 标注（`AnnotationsList` 的 `chapterIdAtPage`）走页码区间匹配，也是对的。唯独 ePub 标注这一处即兴写了 `spinePos===orderIndex` 歪路。

## 需求决策（已确认）

| 决策点     | 结论                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 抽象范围   | **EPUB 专用对称纯函数** `chapterIdAtCfi`，与 PDF `chapterIdAtPage` 对称；不做跨格式统一总入口、不收编当前章追踪                                         |
| 章节计算口 | 新增**唯一**纯函数 `chapterIdAtCfi(chapters, spineHrefs, cfi)`，复用 `chapterIdByHref`                                                                  |
| 数据来源   | 把 epubjs `book` 实例从 `EpubReader` 局部 `useState` **提升为 ReaderView 级 epub-session context**；`EpubReader` 与 `AnnotationsList` 都从 context 消费 |
| 提升粒度   | context 持有 book 实例（语义正确），并对外派生暴露 `spineHrefs`，使 `AnnotationsList` 不必直接持有 book 的副作用方法                                    |
| 数据层     | **不改** schema / 不动主进程 / 不解析 locator（沿用「主进程不解析 locator」黑盒约定）                                                                   |

## 范围外（明确不做）

- 跨格式（epub/pdf）「locator→章节」统一分派入口
- 把 `EpubReader` 的当前章追踪（依赖 iframe DOM / offsetTop）并入抽象
- 修改 `orderIndex` 的语义（它仍服务 TOC 排序 / 全书拼接，不能改成 spine 物理位置）
- 把 spine 顺序持久化进 DB

## ① 核心纯函数 `chapterIdAtCfi`

新文件 `src/renderer/reader/chapter-id-at-cfi.ts`：

```ts
import { EpubCFI } from "epubjs";
import type { ChapterRefDto } from "@shared/library";
import { chapterIdByHref } from "./chapter-id-by-href";

/**
 * ePub 标注/位置 CFI → 章节 id（与 PDF 的 chapterIdAtPage 对称）。
 * spinePos（epubjs spine 物理位置）→ spineHrefs[pos]（spine 顺序的 href）→ chapterIdByHref。
 * 不要用 CFI.spinePos 去撞 chapter.orderIndex：orderIndex 是 TOC 扁平下标，基准不同。
 */
export function chapterIdAtCfi(
  chapters: ChapterRefDto[],
  spineHrefs: string[],
  cfi: string,
): string | null {
  let pos: number;
  try {
    pos = new EpubCFI(cfi).spinePos ?? -1;
  } catch {
    return null;
  }
  const href = pos >= 0 ? spineHrefs[pos] : undefined; // 越界/负 → undefined
  return href ? chapterIdByHref(chapters, href) : null;
}
```

`spineHrefs` 取自 epubjs `book.hrefAtIndex`（epubjs 口径 href）；`chapterIdByHref` 内部 basename 兜底正好消化 epubjs↔parser 前缀差异。

## ② 架构改造：book 提升为 ReaderView 级 epub-session context

新文件 `src/renderer/reader/epub-session.tsx`：`EpubSessionProvider` + `useEpubSession()`。在 `ReaderView` 里包住同时含 Sidebar 与 main 的那层（`src/renderer/reader/ReaderView.tsx:253` 的 flex 容器）。

**搬进 context（本就是 ReaderView 范围状态）：**

- `bytes` query（`qk.bookBytes`，仅 ePub 书 `enabled`；`EpubReader.tsx:81-85`）
- `book` 实例 + `createEpubBook` effect（含 `alive` / `destroy` 清理；`EpubReader.tsx:100-129` 中与 book 生命周期相关的部分）
- `parseError` state（`EpubReader.tsx:56`）
- 派生 `spineHrefs`：book 就绪后 `Array.from({ length: book.count }, (_, i) => book.hrefAtIndex(i) ?? "")`

**context 暴露：** `{ book: EpubBook | null, spineHrefs: string[], parseError: string | null, bytesError: boolean }`

**留在 `EpubReader`（纯 reader 渲染职责，不动逻辑）：**

- `vRef`、所有滚动 / 进度 / 选区 / TTS / decorate 逻辑
- reader 自有 refs：`saveTimer` / `topChapterIdRef` / `topSectionIndexRef` / `restoredRef`
- `progress` / `annotations` query
- 把 `const [book, setBook] = useState` 改为 `const { book, parseError, bytesError } = useEpubSession()`

**⚠️ 拆分关键风险点：** 原 book 创建 effect 的 cleanup 顺手重置了 reader 自有 ref（`EpubReader.tsx:124-127` 的 `saveTimer` / `topChapterIdRef` / `restoredRef`）。拆开后 book 清理归 context，这几个 reader ref 的「切书重置」必须在 `EpubReader` 内用一个监听 `bookId`（或 `book` 实例变化）的 effect 接管——**漏掉会串书**：上一本的进度恢复状态（`restoredRef`）/ 待写进度（`saveTimer`）/ 顶部章快照（`topChapterIdRef`）会漏到下一本。

**PDF 书：** Provider 存在但不创建 book（`bytes` query 不 enabled），`book=null`、`spineHrefs=[]`；`PdfReader` 不消费此 context，无副作用。

## ③ `AnnotationsList` 改造（修 bug）

`src/renderer/reader/AnnotationsList.tsx`：

- 删除 `spineOf` 函数（`AnnotationsList.tsx:16-22`）。
- 从 `useEpubSession()` 取 `spineHrefs`。
- ePub 分支章节标题改走纯函数：

```ts
const chId = chapterIdAtCfi(chapters.data ?? [], spineHrefs, locator);
return (chapters.data ?? []).find((c) => c.id === chId)?.title ?? null;
```

- PDF 分支（`parsePdfLocatorRange` + `chapterIdAtPage`）原样不动。
- 降级：book 未就绪 / PDF 书时 `spineHrefs=[]` → 章节为空（与现状一致，不显示错章）。

## ④ 测试策略

- **TDD 先行**（bug 修复）：先写 `src/renderer/reader/chapter-id-at-cfi.test.ts` 的**失败用例**——核心覆盖「spine 前有封面/版权页致 spinePos 偏移」场景（复现当前错章根因），再实现纯函数转绿。
- 其余边界：`spinePos` 越界 / 负、无效 CFI（构造抛错）、href 前缀差异（basename 兜底命中）、`spineHrefs` 为空数组。
- context 拆分不引入新单测（涉及 epubjs / iframe，无头不可测）；靠 `pnpm typecheck` + 手动冒烟兜底。

## ⑤ 验证关卡（CDP 冒烟）

`pnpm test` + `pnpm typecheck` 通过后，按冒烟纪律真启动 app（`--user-data-dir` 隔离）：

1. 开一本**带封面页**的 ePub，在第 2、3 章各标注 → 侧栏标注章节**与选段实际章节一致**（核心验收）。
2. 进度恢复（重开书回到原位）、跳章、选区高亮、TTS **均不回归**（验证 ② 拆分未破坏时序）。
3. 切到另一本书再切回，标注章节仍正确（验证 reader ref 重置接管，未串书）。

## 涉及文件清单

| 文件                                            | 改动                                        |
| ----------------------------------------------- | ------------------------------------------- |
| `src/renderer/reader/chapter-id-at-cfi.ts`      | 新增纯函数                                  |
| `src/renderer/reader/chapter-id-at-cfi.test.ts` | 新增单测                                    |
| `src/renderer/reader/epub-session.tsx`          | 新增 Provider + hook                        |
| `src/renderer/reader/ReaderView.tsx`            | 包 `EpubSessionProvider`                    |
| `src/renderer/reader/EpubReader.tsx`            | book 改读 context；接管 reader ref 切书重置 |
| `src/renderer/reader/AnnotationsList.tsx`       | 删 `spineOf`，改走 `chapterIdAtCfi`         |
