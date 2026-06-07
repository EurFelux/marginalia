# 工具步骤内联渲染（#31）实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 工具步骤按 `m.parts` 出现顺序内联渲染进 assistant 气泡，紧凑单行 + 带参数人话标题，失败识别覆盖 `{ error }` 软失败。

**Architecture:** 纯渲染层。两个新纯函数模块（`segments` 归并段序列、`tool-step-label` 人话标题/状态判定）+ `MessageList.tsx` 的 `AssistantBubble` 重构 + `AIPanel` 传 `bookId`。零主进程改动。Spec：`docs/superpowers/specs/2026-06-07-inline-tool-steps-design.md`。

**Tech Stack:** React 19（React Compiler 已启用——不手写 memo）、AI SDK v6（`isToolUIPart`/`getToolName`，已确认 `ai` 包导出）、TanStack Query（`qk.chapters` 缓存）、i18next（扁平点分键 + `pnpm i18n:extract --sync-primary`）、vitest。

**关键约束（执行者必读）：**

- `@renderer/i18n` 模块**禁止被 vitest 测到的链路 import**（模块体求值时同步读 `window.api`，无头环境会崩——见该文件头注释）。因此 `tool-step-label.ts` 的 `t` 用参数注入，组件层 `useTranslation()` 取 `t` 传入。
- i18n 文案：源码 `t(key, defaultValue, options)` 的 defaultValue 是 zh-CN（primary）；新增/改文案后跑 `pnpm i18n:extract` 同步 zh-CN locale，en 翻译手动补（extract 给 en 落空串）。extract 先于 typecheck 跑。
- 提交时 prek hook 跑 `lint:fix` + `format`，若报 "files were modified by this hook"，重新 `git add` 再重跑同一条 commit 命令。
- 测试 fixture 构造 AI SDK part 字面量时允许 `as` 收窄（泛型 `UITools` 未具体化所致），但实现代码不得用 `as` 糊类型——用 `isToolUIPart` 收窄。

---

### Task 1: `segments()` 纯函数（parts → 段序列）

**Files:**

- Create: `src/renderer/ai/segments.ts`
- Test: `src/renderer/ai/segments.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/renderer/ai/segments.test.ts
import { describe, expect, it } from "vitest";
import { segments } from "@renderer/ai/segments";
import type { ChatUIMessage } from "@renderer/ai/types";

type Part = ChatUIMessage["parts"][number];

const text = (t: string): Part => ({ type: "text", text: t });
const toolPart = (over: Record<string, unknown> = {}): Part =>
  ({
    type: "tool-readPage",
    toolCallId: "c1",
    state: "output-available",
    input: { page: 1 },
    output: { kind: "text", page: 1, text: "x" },
    ...over,
  }) as Part;
const stepStart: Part = { type: "step-start" } as Part;

describe("segments", () => {
  it("preserves interleaved occurrence order", () => {
    const segs = segments([toolPart(), text("a"), toolPart({ toolCallId: "c2" }), text("b")]);
    expect(segs.map((s) => s.kind)).toEqual(["tool", "text", "tool", "text"]);
  });

  it("merges consecutive text parts into one segment", () => {
    const segs = segments([text("a"), text("b")]);
    expect(segs).toEqual([{ kind: "text", text: "ab" }]);
  });

  it("merges text parts separated only by filtered parts", () => {
    const segs = segments([text("a"), stepStart, text("b")]);
    expect(segs).toEqual([{ kind: "text", text: "ab" }]);
  });

  it("filters step-start and skips empty text parts", () => {
    expect(segments([stepStart, text("")])).toEqual([]);
  });

  it("returns empty for empty parts", () => {
    expect(segments([])).toEqual([]);
  });

  it("treats dynamic-tool parts as tool segments", () => {
    const dyn = {
      type: "dynamic-tool",
      toolName: "webSearch",
      toolCallId: "c9",
      state: "input-available",
      input: {},
    } as Part;
    const segs = segments([dyn]);
    expect(segs).toHaveLength(1);
    expect(segs[0]!.kind).toBe("tool");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/ai/segments.test.ts`
Expected: FAIL（Cannot find module `@renderer/ai/segments`）

- [ ] **Step 3: 最小实现**

```ts
// src/renderer/ai/segments.ts
import { isToolUIPart } from "ai";
import type { DynamicToolUIPart, ToolUIPart } from "ai";
import type { ChatUIMessage } from "@renderer/ai/types";

/** 气泡内可渲染的工具 part（static + dynamic）。 */
export type ToolPart = ToolUIPart | DynamicToolUIPart;

/** 气泡内的一段：合并后的文本块，或单个工具步骤行。 */
export type Segment = { kind: "text"; text: string } | { kind: "tool"; part: ToolPart };

/**
 * 把 UIMessage.parts 按出现顺序归并成段序列：连续 text 合并为一段（与既有
 * textOf 全拼接行为一致，避免 markdown 跨段断裂），tool part 独立成段，
 * 其余 part（step-start 等）过滤。空 text part（流式起点）跳过。
 */
export function segments(parts: ChatUIMessage["parts"]): Segment[] {
  const out: Segment[] = [];
  for (const p of parts) {
    if (p.type === "text") {
      if (p.text === "") continue;
      const last = out.at(-1);
      if (last?.kind === "text") last.text += p.text;
      else out.push({ kind: "text", text: p.text });
    } else if (isToolUIPart(p)) {
      out.push({ kind: "tool", part: p });
    }
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/ai/segments.test.ts`
Expected: PASS（6 个用例全绿）

- [ ] **Step 5: Commit**

```bash
git add src/renderer/ai/segments.ts src/renderer/ai/segments.test.ts
git commit -m "feat(renderer): add segments() to merge message parts in occurrence order"
```

---

### Task 2: `tool-step-label.ts`（人话标题 + 状态判定）

**Files:**

- Create: `src/renderer/ai/tool-step-label.ts`
- Test: `src/renderer/ai/tool-step-label.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/renderer/ai/tool-step-label.test.ts
import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import type { ChapterRefDto } from "@shared/library";
import type { ToolPart } from "@renderer/ai/segments";
import { isErrorShape, toolStepLabel, toolStepStatus } from "@renderer/ai/tool-step-label";

/** stub t：返回 defaultValue 并做 {{var}} 插值，验证 key 选择与参数传递。 */
const t = ((_key: string, defaultValue: string, options?: Record<string, unknown>) =>
  defaultValue.replace(/\{\{(\w+)\}\}/g, (_m, k: string) =>
    String(options?.[k] ?? `{{${k}}}`),
  )) as unknown as TFunction;

const chapter = (over: Partial<ChapterRefDto>): ChapterRefDto => ({
  id: "ch-uuid-1",
  title: "Preface",
  href: "text/preface.xhtml",
  orderIndex: 0,
  level: 0,
  startPage: null,
  endPage: null,
  ...over,
});
const chapters = [chapter({})];

const part = (type: string, over: Record<string, unknown> = {}): ToolPart =>
  ({
    type,
    toolCallId: "c1",
    state: "output-available",
    input: {},
    output: {},
    ...over,
  }) as ToolPart;

describe("toolStepLabel", () => {
  it("readPage with page number", () => {
    expect(toolStepLabel(part("tool-readPage", { input: { page: 12 } }), chapters, t)).toBe(
      "读取第 12 页",
    );
  });

  it("readPage falls back when input is partial (streaming)", () => {
    expect(toolStepLabel(part("tool-readPage", { input: undefined }), chapters, t)).toBe(
      "读取页面",
    );
  });

  it("readChapterText resolves chapter by exact id", () => {
    expect(
      toolStepLabel(
        part("tool-readChapterText", { input: { chapterId: "ch-uuid-1" } }),
        chapters,
        t,
      ),
    ).toBe("读取〈Preface〉");
  });

  it("readChapterText resolves chapter by href", () => {
    expect(
      toolStepLabel(
        part("tool-readChapterText", { input: { chapterId: "text/preface.xhtml" } }),
        chapters,
        t,
      ),
    ).toBe("读取〈Preface〉");
  });

  it("readChapterText resolves chapter by unique case-insensitive title", () => {
    expect(
      toolStepLabel(part("tool-readChapterText", { input: { chapterId: "preface" } }), chapters, t),
    ).toBe("读取〈Preface〉");
  });

  it("readChapterText falls back when unresolved or title is null", () => {
    expect(
      toolStepLabel(part("tool-readChapterText", { input: { chapterId: "nope" } }), chapters, t),
    ).toBe("读取章节文本");
    const untitled = [chapter({ title: null })];
    expect(
      toolStepLabel(
        part("tool-readChapterText", { input: { chapterId: "ch-uuid-1" } }),
        untitled,
        t,
      ),
    ).toBe("读取章节文本");
  });

  it("ambiguous title (two matches) falls back", () => {
    const dup = [chapter({}), chapter({ id: "ch-uuid-2", href: "text/p2.xhtml" })];
    expect(
      toolStepLabel(part("tool-readChapterText", { input: { chapterId: "Preface" } }), dup, t),
    ).toBe("读取章节文本");
  });

  it("getChapterSummary with resolved title", () => {
    expect(
      toolStepLabel(
        part("tool-getChapterSummary", { input: { chapterId: "ch-uuid-1" } }),
        chapters,
        t,
      ),
    ).toBe("读取〈Preface〉摘要");
  });

  it("getToc", () => {
    expect(toolStepLabel(part("tool-getToc"), chapters, t)).toBe("读取目录");
  });

  it("unknown dynamic tool falls back to raw toolName", () => {
    const dyn = part("dynamic-tool", { toolName: "webSearch", input: {} });
    expect(toolStepLabel(dyn, chapters, t)).toBe("webSearch");
  });
});

describe("isErrorShape", () => {
  it("matches { error } object", () => {
    expect(isErrorShape({ error: "boom" })).toBe(true);
  });
  it("rejects others", () => {
    expect(isErrorShape({})).toBe(false);
    expect(isErrorShape(null)).toBe(false);
    expect(isErrorShape("error")).toBe(false);
    expect(isErrorShape(undefined)).toBe(false);
  });
});

describe("toolStepStatus", () => {
  it("output-error → failed", () => {
    expect(toolStepStatus(part("tool-readPage", { state: "output-error", errorText: "x" }))).toBe(
      "failed",
    );
  });
  it("output-available with { error } result → failed (soft failure)", () => {
    expect(toolStepStatus(part("tool-readPage", { output: { error: "chapter not found" } }))).toBe(
      "failed",
    );
  });
  it("output-available with normal result → done", () => {
    expect(toolStepStatus(part("tool-readPage", { output: { kind: "text" } }))).toBe("done");
  });
  it("input-streaming → loading", () => {
    expect(
      toolStepStatus(part("tool-readPage", { state: "input-streaming", output: undefined })),
    ).toBe("loading");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/ai/tool-step-label.test.ts`
Expected: FAIL（Cannot find module `@renderer/ai/tool-step-label`）

- [ ] **Step 3: 最小实现**

```ts
// src/renderer/ai/tool-step-label.ts
import { getToolName } from "ai";
import type { TFunction } from "i18next";
import type { ChapterRefDto } from "@shared/library";
import type { ToolPart } from "@renderer/ai/segments";

/**
 * 工具软失败 result 形状：主进程 runTool 把 execute 抛错转成 { error } 正常 result
 * 喂回模型自我纠正（见 src/main/ai/tools.ts），故 state === "output-error" 几乎不触发，
 * 失败判定必须同时识别本形状。
 */
export function isErrorShape(output: unknown): boolean {
  return typeof output === "object" && output !== null && "error" in output;
}

export type ToolStepStatus = "loading" | "done" | "failed";

/** 步骤行三态：failed 两条腿（硬 error state + 软 { error } result），其余 output-available 为 done。 */
export function toolStepStatus(part: ToolPart): ToolStepStatus {
  if (part.state === "output-error") return "failed";
  if (part.state === "output-available") return isErrorShape(part.output) ? "failed" : "done";
  return "loading";
}

/**
 * 宽容匹配章节引用（与主进程 resolveChapterRef 对齐）：id 精确 → href → 唯一标题
 * （大小写不敏感）。模型给 input 的是原始引用，主进程的规范化结果不回写 input，
 * 渲染层须自行匹配；匹配不到返回 null（调用方回退通用标题）。
 */
function chapterTitle(chapters: ChapterRefDto[], ref: string): string | null {
  const byId = chapters.find((c) => c.id === ref);
  if (byId) return byId.title;
  const byHref = chapters.find((c) => c.href === ref);
  if (byHref) return byHref.title;
  const wanted = ref.trim().toLowerCase();
  const byTitle = chapters.filter((c) => (c.title ?? "").trim().toLowerCase() === wanted);
  return byTitle.length === 1 ? byTitle[0]!.title : null;
}

function inputChapterTitle(
  chapters: ChapterRefDto[],
  input: Record<string, unknown> | undefined,
): string | null {
  return typeof input?.chapterId === "string" ? chapterTitle(chapters, input.chapterId) : null;
}

/**
 * 步骤行人话标题：带参数（页码/章节名）让用户一眼看懂 AI 在干什么；
 * 参数缺失（流式 partial input）或解析不到时回退工具级通用标题，绝不抛错。
 * t 由组件层注入——本模块不得 import @renderer/i18n（无头测试会崩，见其头注释）。
 */
export function toolStepLabel(part: ToolPart, chapters: ChapterRefDto[], t: TFunction): string {
  const name = getToolName(part);
  const input = part.input as Record<string, unknown> | undefined;
  switch (name) {
    case "readPage": {
      const page = input?.page;
      return typeof page === "number"
        ? t("ai.toolStep.readPage", "读取第 {{page}} 页", { page })
        : t("ai.toolStep.readPageFallback", "读取页面");
    }
    case "readChapterText": {
      const title = inputChapterTitle(chapters, input);
      return title !== null
        ? t("ai.toolStep.readChapterText", "读取〈{{title}}〉", { title })
        : t("ai.toolStep.readChapterTextFallback", "读取章节文本");
    }
    case "getChapterSummary": {
      const title = inputChapterTitle(chapters, input);
      return title !== null
        ? t("ai.toolStep.getChapterSummary", "读取〈{{title}}〉摘要", { title })
        : t("ai.toolStep.getChapterSummaryFallback", "读取章节摘要");
    }
    case "getToc":
      return t("ai.toolStep.getToc", "读取目录");
    default:
      return name;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/ai/tool-step-label.test.ts`
Expected: PASS（全部用例绿）

- [ ] **Step 5: Commit**

```bash
git add src/renderer/ai/tool-step-label.ts src/renderer/ai/tool-step-label.test.ts
git commit -m "feat(renderer): add tool step label/status helpers with lenient chapter resolution"
```

---

### Task 3: `MessageList` 重构（内联渲染）+ `AIPanel` 接线

**Files:**

- Modify: `src/renderer/ai/MessageList.tsx`（`AssistantBubble` 重构、`ToolStepCard` → `ToolStepRow`、`MessageList` 加 `bookId` prop）
- Modify: `src/renderer/ai/AIPanel.tsx:129`（传 `bookId`）

无单测（组件薄壳，逻辑已在 Task 1/2 覆盖；视觉靠 Task 5 冒烟）。

- [ ] **Step 1: 重写 `MessageList.tsx`**

完整新文件内容（`UserBubble` 与 `textOf` 原样保留——`textOf` 仍被 `UserBubble` 使用）：

```tsx
import type { ChatStatus } from "ai";
import { getToolName } from "ai";
import { useQuery } from "@tanstack/react-query";
import type { LucideIcon } from "lucide-react";
import { BookOpen, FileText, List, ScrollText, Sparkles, Wrench } from "lucide-react";
import { useTranslation } from "react-i18next";
import { chipLabel } from "@renderer/ai/chip-label";
import { segments, type ToolPart } from "@renderer/ai/segments";
import { toolStepLabel, toolStepStatus } from "@renderer/ai/tool-step-label";
import type { ChatUIMessage } from "@renderer/ai/types";
import { LocalizedStreamdown } from "@renderer/components/LocalizedStreamdown";
import { cn } from "@renderer/lib/utils";
import { qk } from "@renderer/query/keys";
import type { ChapterRefDto } from "@shared/library";

function textOf(m: ChatUIMessage): string {
  return m.parts.map((p) => (p.type === "text" ? p.text : "")).join("");
}

export function MessageList({
  messages,
  status,
  bookId,
}: {
  messages: ChatUIMessage[];
  status: ChatStatus;
  bookId: string | null;
}) {
  const { t } = useTranslation();
  // 章节列表给步骤行解析人话标题（chapterId → 章节名）；静态数据，与 ChapterList 共享缓存。
  const chaptersQuery = useQuery({
    queryKey: qk.chapters(bookId ?? ""),
    queryFn: () => window.api.content.chapters({ bookId: bookId ?? "" }),
    enabled: bookId !== null,
  });
  const chapters = chaptersQuery.data ?? [];
  if (messages.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 px-8 text-center text-sm text-muted-foreground">
        <Sparkles className="size-7 text-primary/50" />
        <p className="leading-relaxed">
          {t("ai.emptyHint", "划选正文后点「AI 问」，或直接在下方提问。")}
        </p>
      </div>
    );
  }
  const lastId = messages.at(-1)?.id;
  return (
    <div className="space-y-5">
      {messages.map((m) =>
        m.role === "user" ? (
          <UserBubble key={m.id} m={m} />
        ) : (
          <AssistantBubble
            key={m.id}
            m={m}
            streaming={status === "streaming" && m.id === lastId}
            chapters={chapters}
          />
        ),
      )}
    </div>
  );
}

function UserBubble({ m }: { m: ChatUIMessage }) {
  /* ……原样保留，勿动…… */
}

function AssistantBubble({
  m,
  streaming,
  chapters,
}: {
  m: ChatUIMessage;
  streaming: boolean;
  chapters: ChapterRefDto[];
}) {
  const segs = segments(m.parts);
  const hasText = segs.some((s) => s.kind === "text");
  if (segs.length === 0 && !streaming) return null;
  return (
    <div className="flex flex-col items-start">
      <div className="max-w-[88%] space-y-2 rounded-2xl rounded-bl-sm bg-muted px-3.5 py-2 text-sm leading-relaxed text-foreground">
        {segs.map((s, i) =>
          s.kind === "text" ? (
            // Streamdown 自带 markdown 排版（经 @source 由 Tailwind 生成其类）；不叠 prose 以免边距打架
            <LocalizedStreamdown key={i}>{s.text}</LocalizedStreamdown>
          ) : (
            <ToolStepRow key={i} part={s.part} chapters={chapters} />
          ),
        )}
        {streaming && !hasText && (
          <span className="inline-block animate-pulse text-primary">▍</span>
        )}
      </div>
    </div>
  );
}

/** 步骤行图标：lucide 按工具映射，未知工具兜底扳手。 */
const TOOL_ICONS: Record<string, LucideIcon> = {
  getToc: List,
  getChapterSummary: ScrollText,
  readChapterText: BookOpen,
  readPage: FileText,
};

function ToolStepRow({ part, chapters }: { part: ToolPart; chapters: ChapterRefDto[] }) {
  const { t } = useTranslation();
  const status = toolStepStatus(part);
  const Icon = TOOL_ICONS[getToolName(part)] ?? Wrench;
  return (
    <div className="flex items-center gap-1.5 text-xs text-muted-foreground">
      <Icon className="size-3.5 shrink-0" aria-hidden />
      <span className="min-w-0 truncate">{toolStepLabel(part, chapters, t)}</span>
      {/* i18next-instrument-ignore */}
      <span className="shrink-0">·</span>
      <span
        className={cn(
          "shrink-0",
          status === "failed" && "text-destructive",
          status === "loading" && "animate-pulse",
        )}
      >
        {status === "failed"
          ? t("ai.toolStep.failed", "失败")
          : status === "done"
            ? t("ai.toolStep.done", "完成")
            : t("ai.toolStep.loading", "读取中…")}
      </span>
    </div>
  );
}
```

要点：

- `ToolStepCard` 整个删除（其手写 `as { type: string; ... }` cast 随之消失——#46 的一角）。
- 状态 defaultValue 变更：`done`「已读取」→「完成」、`failed`「读取失败」→「失败」（人话标题已含「读取」动词）；`loading` 不变。
- 光标条件从 `text === ""` 改为 `!hasText`：工具行自带「读取中…」活动指示，但正文未开流前仍需光标兜底。
- segments 顺序稳定（流式中只追加、text 原位增长），index key 安全。

- [ ] **Step 2: `AIPanel.tsx` 传 bookId**

`AIPanel.tsx:129` 改为：

```tsx
<MessageList messages={messages} status={status} bookId={bookId} />
```

（`bookId` 变量已在 `AIPanel.tsx:30` 存在：`useNavigationStore((s) => s.currentBookId)`。）

- [ ] **Step 3: 全量验证**

Run: `pnpm i18n:extract && pnpm typecheck && pnpm lint && pnpm test`
Expected: 全绿；extract 后 `git diff src/shared/i18n/locales/` 应出现新 `ai.toolStep.*` 键（zh-CN 带文案、en 为空串）且 `done`/`failed` 的 zh-CN 文案更新——**diff 确认无既有键被误删/误改**（i18n 坑：extract 可能用旧 fallback 反向覆盖）。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/ai/MessageList.tsx src/renderer/ai/AIPanel.tsx src/shared/i18n/locales/
git commit -m "feat(renderer): render tool steps inline inside assistant bubble"
```

---

### Task 4: en 翻译补全

**Files:**

- Modify: `src/shared/i18n/locales/en.ts`（extract 落的空串键）

- [ ] **Step 1: 补英文翻译**

在 `en.ts` 中把 Task 3 extract 产出的空串键填为：

```ts
"ai.toolStep.getChapterSummary": "Reading summary of “{{title}}”",
"ai.toolStep.getChapterSummaryFallback": "Reading chapter summary",
"ai.toolStep.getToc": "Reading table of contents",
"ai.toolStep.readChapterText": "Reading “{{title}}”",
"ai.toolStep.readChapterTextFallback": "Reading chapter text",
"ai.toolStep.readPage": "Reading page {{page}}",
"ai.toolStep.readPageFallback": "Reading page",
```

既有 `ai.toolStep.{done,failed,loading}` 的 en 值（Done/Failed/Loading…）语义不变，保留。

- [ ] **Step 2: 验证无空串遗留**

Run: `grep -n '""' src/shared/i18n/locales/en.ts`
Expected: 无 `ai.toolStep.*` 相关空串（其他历史空串不属本计划范围）。再跑 `pnpm i18n:status` 确认覆盖率未降。

- [ ] **Step 3: Commit**

```bash
git add src/shared/i18n/locales/en.ts
git commit -m "feat(i18n): add English translations for inline tool step labels"
```

---

### Task 5: 全量验证 + CDP 冒烟

**Files:**

- Create（临时，不提交）: `/tmp/smoke-inline-tool-steps.mjs`

- [ ] **Step 1: 全量门禁**

Run: `pnpm i18n:extract && pnpm typecheck && pnpm lint && pnpm format:check && pnpm test`
Expected: 全绿，且 extract 后 `git status` 干净（无 locale 漂移）。

- [ ] **Step 2: 启动 dev + CDP 冒烟**

```bash
pnpm start -- --remote-debugging-port=9333
```

（后台运行；恰好一个 `--`，多一个裸 `--` 会让开关静默失效。用默认 dev userData——marginalia-dev 库里有书和 provider key，冒烟需要真模型流式。）

playwright-core 脚本要点（`connectOverCDP` 必须传 ws URL，从 `http://localhost:9333/json/version` 取 `webSocketDebuggerUrl`）：

1. 打开一本书 → 打开 AI 面板；
2. 用 `fill`/`press` 真实事件输入需要工具的问题（如「这本书的目录里有哪些章节？请读取目录后回答」）并发送；
3. 等待流式完成，断言：步骤行出现在 assistant 气泡 **内部**（DOM 上步骤行与正文同属一个 `bg-muted` 容器）、标题是人话（含「读取目录」）、状态从「读取中…」变「完成」；
4. 截图存 `/tmp/inline-tool-steps-smoke.png` 供目视确认（含正文与步骤行的交错布局）。

Expected: 断言通过 + 截图目视无布局异常。**若 dev 库无书或无 key，停下来请用户配合**，勿造假数据绕过。

- [ ] **Step 3: 历史消息回归**

冒烟脚本（或人工）切走再切回该会话，断言历史水合后的步骤行同样内联渲染（parts 已持久化，应自然生效）。

- [ ] **Step 4: 杀掉 dev 进程**

只杀本 worktree 启动的进程（记下 Step 2 的 PID 用 `kill <PID>`；勿用宽 `pkill` 误杀别的 worktree）。

---

## 收尾（计划外，finishing 流程）

实现完成后按 finishing-a-development-branch skill 走：`pnpm changeset`（用户可见变更，要写）、ROADMAP 不需更新（需求已迁 GitHub Issues）、合并时 commit 带 `closes #31`、kanban 挪列。
