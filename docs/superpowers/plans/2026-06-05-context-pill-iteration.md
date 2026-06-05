# 上下文 Pill 体系迭代实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 章节摘要 pill 迁顶栏；Composer 上方统一 `ContextPillBar`（摘要 toggle + 可删除的合并选区 pill），全部 pill 用 HoverCard 预览内容、缺失摘要虚线态；chip 构建值 `"required"` → `"on"`。

**Architecture:** 纯 renderer 展示层迭代（主进程仅 `chips.ts` 一行）。`SummaryChipToggles`/`ChipBar` 退役并入新 `ContextPillBar`；hover 统一 Base UI PreviewCard（shadcn hover-card）；物化/状态机/send 链全部不动。

**Tech Stack:** React 19（React Compiler，禁手写 useCallback/useMemo）、@base-ui/react PreviewCard、TanStack Query、zustand、Tailwind（禁内联 style）、vitest。

**Spec:** `docs/superpowers/specs/2026-06-05-context-pill-iteration-design.md`

**分支：** 已在 `feat/context-pill-iteration`（从 main 112b437 切出），勿再建分支。

**通用注意：** 禁止 `git -C`；禁止 `npx`/`bunx`（用 `pnpx`）；prek hook 改文件中止提交时 re-add 后重跑同一条命令；i18n 新文案只写 `t("key", "默认值")`，locale 由 Task 6 extract 收口。

---

### Task 1: chips 构建值 `"required"` → `"on"`

**Files:**

- Modify: `src/main/ai/chips.ts`（buildChips 两处）
- Test: `src/main/ai/chips.test.ts`

- [ ] **Step 1: 改测试断言（跑红）**

`src/main/ai/chips.test.ts` 中对 buildChips 产出 `state` 的断言从 `"required"` 改为 `"on"`（用 `grep -n '"required"' src/main/ai/chips.test.ts` 找全；手造 Chip 字面量作为**输入**的不用改，只改对 buildChips **输出**的断言）。

Run: `pnpm test src/main/ai/chips.test.ts` → Expected: FAIL（实现仍构建 required）。

- [ ] **Step 2: 改实现（跑绿）**

`src/main/ai/chips.ts` buildChips 中 selection 与 paragraph 两处 `state: "required"` → `state: "on"`，并更新函数 doc 注释为：

```ts
/** 由 renderer 提取的原始文本构造 selection / paragraph chip（构建为 on：随消息发送、UI 可整体删除；"required" 仅历史水合产出）。 */
```

Run: `pnpm test src/main/ai/chips.test.ts` → PASS。

- [ ] **Step 3: 全量验证 + Commit**

```bash
pnpm typecheck && pnpm test
git add -A && git commit -m "refactor(chips): build selection/paragraph chips as on — required is hydration-only"
```

（若其他测试因精确匹配构建值而红，按同精神同步；send 链 `state !== "off"` 过滤对 `"on"` 照发，行为零变化。）

---

### Task 2: hover-card UI 组件

**Files:**

- Create: `src/renderer/components/ui/hover-card.tsx`

- [ ] **Step 1: 尝试 shadcn CLI**

```bash
pnpx shadcn@latest add hover-card
```

若成功生成 `src/renderer/components/ui/hover-card.tsx`（components.json 为 base-nova style，应产出 @base-ui/react 包装）：检查 import 是否为 `@base-ui/react`（非旧 `@base-ui-components`）；`git diff` 确认未动其他文件（CLI 有时改 css/token——**勿让它覆盖既有 token**，误改就 revert 那部分）。装完跑 `pnpm db:rebuild:electron`（防 CLI 触发安装把 better-sqlite3 翻回 node ABI；没动依赖则此步秒完无害）。

- [ ] **Step 2: CLI 不可用时手写（镜像 popover.tsx 包装模式）**

读 `src/renderer/components/ui/popover.tsx` 的既有包装（Root/Trigger/Portal/Positioner/Popup 层级、className 合并方式、render prop 用法），对 `@base-ui/react/preview-card` 写同构包装：

```tsx
import { PreviewCard } from "@base-ui/react/preview-card";
import { cn } from "@renderer/lib/utils";

function HoverCard(props: React.ComponentProps<typeof PreviewCard.Root>) {
  return <PreviewCard.Root delay={300} closeDelay={150} {...props} />;
}

const HoverCardTrigger = PreviewCard.Trigger;

function HoverCardContent({
  className,
  sideOffset = 6,
  align = "start",
  side = "top",
  ...props
}: React.ComponentProps<typeof PreviewCard.Popup> & {
  sideOffset?: number;
  align?: "start" | "center" | "end";
  side?: "top" | "bottom" | "left" | "right";
}) {
  return (
    <PreviewCard.Portal>
      <PreviewCard.Positioner side={side} align={align} sideOffset={sideOffset} className="z-50">
        <PreviewCard.Popup
          className={cn(
            "w-80 rounded-lg border border-border bg-popover p-3 text-xs leading-relaxed text-popover-foreground shadow-xl outline-none",
            className,
          )}
          {...props}
        />
      </PreviewCard.Positioner>
    </PreviewCard.Portal>
  );
}

export { HoverCard, HoverCardTrigger, HoverCardContent };
```

（Positioner/Popup 的确切 props 名以 popover.tsx 同名结构与 `node_modules/@base-ui/react/esm/preview-card/index.d.ts` 为准微调；动画类参考 popover.tsx 现状，没有就不加。）

- [ ] **Step 3: 验证 + Commit**

```bash
pnpm typecheck && pnpm test
git add -A && git commit -m "feat(ui): add hover-card (Base UI PreviewCard wrapper)"
```

---

### Task 3: selection-context 纯函数

**Files:**

- Create: `src/renderer/ai/selection-context.ts`
- Test: Create `src/renderer/ai/selection-context.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/renderer/ai/selection-context.test.ts
import { describe, expect, it } from "vitest";
import type { Chip } from "@shared/chat";
import { selectionContextOf, withoutSelectionContext } from "@renderer/ai/selection-context";

const chip = (id: Chip["id"], tokenCount: number): Chip => ({
  id,
  labelKey: `chip.${id}`,
  content: `${id}-content`,
  tokenCount,
  state: "on",
});

describe("selectionContextOf", () => {
  it("aggregates selection + paragraph with token total", () => {
    const ctx = selectionContextOf([chip("selection", 12), chip("paragraph", 70)]);
    expect(ctx?.selection?.content).toBe("selection-content");
    expect(ctx?.paragraph?.content).toBe("paragraph-content");
    expect(ctx?.tokenTotal).toBe(82);
  });

  it("returns null when neither selection nor paragraph present", () => {
    expect(selectionContextOf([])).toBeNull();
    expect(selectionContextOf([chip("chapter-summary", 5)])).toBeNull();
  });

  it("works with selection only (paragraph deduped away upstream)", () => {
    const ctx = selectionContextOf([chip("selection", 12)]);
    expect(ctx?.paragraph).toBeNull();
    expect(ctx?.tokenTotal).toBe(12);
  });
});

describe("withoutSelectionContext", () => {
  it("removes selection and paragraph, keeps others", () => {
    const rest = withoutSelectionContext([
      chip("selection", 1),
      chip("paragraph", 2),
      chip("book-summary", 3),
    ]);
    expect(rest.map((c) => c.id)).toEqual(["book-summary"]);
  });
});
```

Run: `pnpm test src/renderer/ai/selection-context.test.ts` → FAIL（模块不存在）。

- [ ] **Step 2: 实现**

```ts
// src/renderer/ai/selection-context.ts
import type { Chip } from "@shared/chat";

export interface SelectionContext {
  selection: Chip | null;
  paragraph: Chip | null;
  tokenTotal: number;
}

/** draft 中选区上下文（selection/paragraph chips）的聚合视图（spec §4 合并 pill）；两者皆无 → null。 */
export function selectionContextOf(chips: Chip[]): SelectionContext | null {
  const selection = chips.find((c) => c.id === "selection") ?? null;
  const paragraph = chips.find((c) => c.id === "paragraph") ?? null;
  if (!selection && !paragraph) return null;
  return {
    selection,
    paragraph,
    tokenTotal: (selection?.tokenCount ?? 0) + (paragraph?.tokenCount ?? 0),
  };
}

/** 整体移除选区上下文（spec §4：一次反悔动作，发送前可撤）。 */
export function withoutSelectionContext(chips: Chip[]): Chip[] {
  return chips.filter((c) => c.id !== "selection" && c.id !== "paragraph");
}
```

Run: `pnpm test src/renderer/ai/selection-context.test.ts` → PASS。

- [ ] **Step 3: Commit**

```bash
git add -A && git commit -m "feat(ai): selection-context aggregation helpers"
```

---

### Task 4: ContextPillBar + Composer 接线 + 旧组件退役

**Files:**

- Create: `src/renderer/ai/ContextPillBar.tsx`
- Modify: `src/renderer/ai/Composer.tsx`
- Delete: `src/renderer/ai/SummaryChipToggles.tsx`、`src/renderer/ai/ChipBar.tsx`

- [ ] **Step 1: 写 ContextPillBar**

```tsx
// src/renderer/ai/ContextPillBar.tsx
import type { ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FileText, Loader2, TextSelect, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SummaryStatus } from "@shared/library";
import { cn } from "@renderer/lib/utils";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@renderer/components/ui/hover-card";
import { useChatStore } from "@renderer/store/chat-store";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { bookSummaryQuery, chapterSummaryQuery } from "@renderer/query/summary-queries";
import { qk } from "@renderer/query/keys";
import type { SummaryView } from "@renderer/ai/summary-chips";
import { selectionContextOf, withoutSelectionContext } from "@renderer/ai/selection-context";

/**
 * 统一上下文 pill 基件（spec §4）：实线亮(on)/实线灰(off)/虚线缺失(missing，正交于亮灰)。
 * hover 整个 pill 触发 HoverCard 预览；主体点击与右侧 × 动作分离（避免嵌套交互元素）。
 */
function ContextPill(props: {
  icon: ReactNode;
  label: string;
  on: boolean;
  missing?: boolean;
  onClick?: () => void;
  ariaPressed?: boolean;
  onRemove?: () => void;
  removeLabel?: string;
  trailing?: ReactNode;
  hover: ReactNode;
}) {
  return (
    <HoverCard>
      <HoverCardTrigger
        render={
          <div
            className={cn(
              "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
              props.missing ? "border-dashed" : "border-solid",
              props.on
                ? "border-primary/40 bg-primary/10 text-foreground"
                : "border-border bg-muted/40 text-muted-foreground hover:bg-muted",
            )}
          />
        }
      >
        <button
          type="button"
          onClick={props.onClick}
          aria-pressed={props.ariaPressed}
          className="flex items-center gap-1"
        >
          {props.icon}
          {props.label}
          {props.trailing}
        </button>
        {props.onRemove && (
          <button
            type="button"
            onClick={props.onRemove}
            aria-label={props.removeLabel}
            className="ms-0.5 text-muted-foreground/60 hover:text-foreground"
          >
            <X className="size-3" />
          </button>
        )}
      </HoverCardTrigger>
      <HoverCardContent>{props.hover}</HoverCardContent>
    </HoverCard>
  );
}

/** 摘要 hover 内容：ready 显正文（限高滚动），其余显状态占位（spec §5）。SummaryView 复用 summary-chips 的导出，勿重复定义。 */
function SummaryHover({
  view,
  t,
}: {
  view: SummaryView | undefined;
  t: (k: string, d: string) => string;
}) {
  const status = view?.status ?? "pending";
  if (status === "ready" && view?.summary) {
    return (
      <ScrollArea viewportClassName="max-h-40">
        <p className="whitespace-pre-wrap text-muted-foreground">{view.summary}</p>
      </ScrollArea>
    );
  }
  const placeholder =
    status === "generating"
      ? t("ai.chip.hoverGenerating", "生成中…")
      : status === "unavailable"
        ? t("ai.chip.hoverUnavailable", "生成失败，点击重试")
        : t("ai.chip.hoverPending", "尚未生成，点击生成");
  return <p className="text-muted-foreground">{placeholder}</p>;
}

/**
 * Composer 上方统一上下文 pill 行（spec §4）：摘要 toggle ×2 + 可删除的合并选区 pill。
 * 摘要行为与原 SummaryChipToggles 一致：手动 off→on 且未生成（pending/unavailable）触发生成
 * （主进程 inFlight 幂等兜底）；自动预亮不触发。
 */
export function ContextPillBar() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const bookId = useNavigationStore((s) => s.currentBookId);
  const chapterId = useNavigationStore((s) => s.currentChapterId);
  const summaryChips = useChatStore((s) => s.summaryChips);
  const setSummaryChip = useChatStore((s) => s.setSummaryChip);
  const draftChips = useChatStore((s) => s.draftChips);
  const setDraftChips = useChatStore((s) => s.setDraftChips);

  const chapter = useQuery({
    ...chapterSummaryQuery(bookId ?? "", chapterId ?? ""),
    enabled: !!bookId && !!chapterId,
  });
  const book = useQuery({ ...bookSummaryQuery(bookId ?? ""), enabled: !!bookId });

  if (!bookId) return null;

  const selCtx = selectionContextOf(draftChips);

  const toggle = (kind: "chapter" | "book", status: SummaryStatus | undefined, on: boolean) => {
    if (!on && (status === "pending" || status === "unavailable")) {
      if (kind === "chapter" && chapterId) {
        void window.api.content
          .generateChapterSummary({ bookId, chapterId })
          .then(() => qc.invalidateQueries({ queryKey: qk.chapterSummary(bookId, chapterId) }))
          .catch(() => undefined);
      } else if (kind === "book") {
        void window.api.content
          .generateBookSummary({ bookId })
          .then(() => qc.invalidateQueries({ queryKey: qk.bookSummary(bookId) }))
          .catch(() => undefined);
      }
    }
    setSummaryChip(kind, !on);
  };

  const summaryPill = (
    kind: "chapter" | "book",
    label: string,
    view: SummaryView | undefined,
    on: boolean,
    Icon: typeof FileText,
  ) => {
    const status = view?.status;
    return (
      <ContextPill
        icon={
          status === "generating" ? (
            <Loader2 className="size-3 animate-spin" />
          ) : (
            <Icon className="size-3" />
          )
        }
        label={label}
        on={on}
        missing={status === "pending" || status === "unavailable"}
        onClick={() => toggle(kind, status, on)}
        ariaPressed={on}
        hover={<SummaryHover view={view} t={t} />}
      />
    );
  };

  return (
    <div className="mb-2 flex flex-wrap gap-1.5">
      {chapterId &&
        summaryPill(
          "chapter",
          t("ai.chip.chapterSummary", "章节摘要"),
          chapter.data,
          summaryChips.chapter,
          FileText,
        )}
      {summaryPill(
        "book",
        t("ai.chip.bookSummary", "全书摘要"),
        book.data,
        summaryChips.book,
        BookOpen,
      )}
      {selCtx && (
        <ContextPill
          icon={<TextSelect className="size-3" />}
          label={t("ai.chip.selectionContext", "选区上下文")}
          on
          trailing={
            <span className="text-[10px] tabular-nums text-muted-foreground">
              ≈{selCtx.tokenTotal} {t("ai.tokUnit", "tok")}
            </span>
          }
          onRemove={() => setDraftChips(withoutSelectionContext(draftChips))}
          removeLabel={t("ai.chip.removeContext", "移除选区上下文")}
          hover={
            <ScrollArea viewportClassName="max-h-52">
              <div className="space-y-2">
                {selCtx.selection && (
                  <div>
                    <div className="mb-0.5 font-medium text-foreground">
                      {t("ai.chip.selection", "选区")} ·{" "}
                      <span className="tabular-nums">≈{selCtx.selection.tokenCount}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-muted-foreground">
                      {selCtx.selection.content}
                    </p>
                  </div>
                )}
                {selCtx.paragraph && (
                  <div>
                    <div className="mb-0.5 font-medium text-foreground">
                      {t("ai.chip.paragraph", "段落上下文")} ·{" "}
                      <span className="tabular-nums">≈{selCtx.paragraph.tokenCount}</span>
                    </div>
                    <p className="whitespace-pre-wrap text-muted-foreground">
                      {selCtx.paragraph.content}
                    </p>
                  </div>
                )}
              </div>
            </ScrollArea>
          }
        />
      )}
    </div>
  );
}
```

（HoverCardTrigger 的 render prop 用法以 Task 2 产出的组件实际 API 为准——Base UI 是 render prop 非 Slot；若 Trigger 不支持 render 包 div，改为 Trigger 默认元素 + className 传 pill 样式，结构微调以编译/手测为准。）

- [ ] **Step 2: Composer 接线**

`src/renderer/ai/Composer.tsx`：

- imports：删 `ChipBar`、`SummaryChipToggles`，加 `ContextPillBar`。
- JSX（原 71-77 行区域）：

```tsx
    <div className="shrink-0 border-t border-border bg-card/40 p-3">
      <ContextPillBar />
      <div className="flex items-end gap-2 rounded-xl border border-border bg-background p-2 focus-within:ring-1 focus-within:ring-ring">
```

（`{draftChips.length > 0 && <ChipBar …/>}` 块整体删除——选区展示已并入 bar；`send()` 物化与回落逻辑**不动**。）

- [ ] **Step 3: 退役旧组件**

```bash
rm src/renderer/ai/SummaryChipToggles.tsx src/renderer/ai/ChipBar.tsx
grep -rn "SummaryChipToggles\|ChipBar" src/ # 应零命中
```

- [ ] **Step 4: 验证 + Commit**

```bash
pnpm typecheck && pnpm test
git add -A && git commit -m "feat(ai): unified ContextPillBar — summary toggles + removable selection pill with hover preview"
```

---

### Task 5: SummaryPill 迁顶栏

**Files:**

- Modify: `src/renderer/ai/SummaryPill.tsx`（门控）
- Modify: `src/renderer/reader/ReaderView.tsx`（面包屑后挂载）
- Modify: `src/renderer/ai/AIPanel.tsx`（移除）

- [ ] **Step 1: SummaryPill 门控改常驻**

`src/renderer/ai/SummaryPill.tsx`：

- 删 `usePrefsStore` import 与 `const panelOpen = usePrefsStore(...)` 行。
- query `enabled: panelOpen && bookId != null && chapterId != null` → `enabled: bookId != null && chapterId != null`。
- `PopoverContent` 的 `align="end"` → `align="start"`（pill 现在在顶栏左区，弹卡向右下展开更自然；手测不顺眼可调回）。
- 组件 doc 注释首行改为 `/** 阅读器顶栏的本章摘要 pill：显示摘要状态，点开弹卡看正文（spec §3 自 AI 面板迁入）。 */`（保留其余说明）。

- [ ] **Step 2: ReaderView 挂载**

`src/renderer/reader/ReaderView.tsx` 面包屑块（`{breadcrumb && (...)}`，约 121-126 行）之后插入：

```tsx
<div className="hidden shrink-0 sm:block">
  <SummaryPill />
</div>
```

加 import `import { SummaryPill } from "@renderer/ai/SummaryPill";`。（SummaryPill 自带 `!bookId || !chapterId → null` 守卫，无需外层条件。）

- [ ] **Step 3: AIPanel 移除**

`src/renderer/ai/AIPanel.tsx`：删 `<SummaryPill />`（header 右侧动作区）与其 import。header 剩：标题块 + 新对话「+」 + 关闭。

- [ ] **Step 4: 验证 + Commit**

```bash
pnpm typecheck && pnpm test
git add -A && git commit -m "feat(reader): move chapter summary pill to top bar"
```

---

### Task 6: i18n extract + 全量验证 + 真启动冒烟 + changeset

- [ ] **Step 1: i18n extract**

```bash
pnpm i18n:extract
git diff src/shared/i18n/locales/
```

预期：新增 `ai.chip.selectionContext` / `ai.chip.removeContext` / `ai.chip.hoverPending` / `ai.chip.hoverGenerating` / `ai.chip.hoverUnavailable`；删除 `ai.chip.requiredContext` / `ai.chip.willSend`（ChipBar 退役）。en.ts 新 key 手补英文："Selection context" / "Remove selection context" / "Not generated yet — click to generate" / "Generating…" / "Generation failed — click to retry"。用 grep 复核删除 key 确无引用（i18n:lint 有漏报）。

- [ ] **Step 2: 全量验证**

```bash
pnpm i18n:lint && pnpm typecheck && pnpm lint && pnpm test
git add -A && git commit -m "chore(i18n): sync locales for context pill iteration"
```

- [ ] **Step 3: 真启动冒烟**

```bash
rm -rf /tmp/marginalia-pill-smoke && cp -R "$HOME/Library/Application Support/marginalia-dev" /tmp/marginalia-pill-smoke
pnpm start -- --user-data-dir=/tmp/marginalia-pill-smoke --remote-debugging-port=9224
```

手测/CDP 清单：① 顶栏面包屑后见摘要 pill（点开弹卡正常、AI 面板 header 无 pill）；② Composer 上方三 pill（缺摘要虚线、hover 出 HoverCard 预览）；③ 划词后选区 pill 出现（合计 token），点 × 删除后发送的消息不带选区 chips（气泡无徽标）；④ toggle 开关与物化回落行为同前。完毕后清理 /tmp 副本。

- [ ] **Step 4: changeset + 收尾**

```bash
pnpm changeset
```

minor，英文条目示例："The chapter summary pill moves to the reader top bar, and the composer gets a unified context pill row — hover any pill to preview its content, dashed borders mark missing summaries, and the selection context can be removed before sending."

```bash
git add -A && git commit -m "chore: changeset for context pill iteration"
```

完成后走 superpowers:finishing-a-development-branch（rebase/ff 合 main、更新 ROADMAP——「下一目标候选」的「进行中：AI panel 上下文 pill 体系迭代」改为已交付段落、ChipBar PreviewCard 延后项表格行删除）。

---

## 验收对照（spec → task）

| spec 节                                    | 任务                                              |
| ------------------------------------------ | ------------------------------------------------- |
| §3 顶栏迁移                                | Task 5                                            |
| §4 ContextPillBar / 合并选区 pill / 虚线态 | Task 4（基件 + bar）、Task 3（聚合函数）          |
| §5 Hover Card                              | Task 2（组件）、Task 4（接入）                    |
| §6 三态语义微调                            | Task 1、Task 6 Step 1（requiredContext 文案删除） |
| §8 测试与验证                              | 各任务内嵌 + Task 6                               |
