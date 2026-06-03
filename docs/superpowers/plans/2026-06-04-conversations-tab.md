# 会话 tab（列表 + 重开）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给阅读器侧栏加第三个「会话」tab：列出本书会话、点击重开并把历史消息载入 AI 面板；会话创建时落「随便起」的 title（首条消息截断，未来自动命名覆盖同字段）。

**Architecture:** 后端只加 `setConversationTitle` + 纯函数 `deriveConversationTitle`，`runSend` 在首建会话时落 title（DTO/IPC/路由不改）。渲染层：`ConversationsTab` 用已暴露的 `listByBook` 列会话；重开经 chat-store 的**一次性 `openCommand` 命令信号**（镜像 `annotation-store.scrollCommand`）驱动 `AIPanel` 载历史 + `setMessages`——**不监听 `activeConversationId`**（避免发消息 ack 串台）。TabsList 改「图标恒显 + 仅选中显文字 label」（i18n 宽度适配）。

**Tech Stack:** TypeScript 6（strict）、React 19 + React Compiler、@ai-sdk/react `useChat`、TanStack Query、zustand、Base UI Tabs（shadcn 封装）、react-i18next（扁平点分键 + i18next-cli）、vitest（Electron 运行时）、oxlint/oxfmt。

**设计文档：** `docs/superpowers/specs/2026-06-03-conversations-tab-design.md`

---

## 关键约定（每个任务都适用）

- **运行单测：** `pnpm test <path>`。**全量门禁：** `pnpm typecheck && pnpm lint && pnpm test`。
- **提交：** pre-commit（prek）跑 `lint:fix`+`format`，若以 "files were modified by this hook" 中止，`git add` 被改文件后**重跑同一 commit** 即过。
- **i18n 类型**：合法 `t()` key 由 `src/shared/i18n/locales/zh-CN.ts`（`typeof zhCN`）派生（见 `i18next.d.ts`）。新增 key 必须先加到 `zh-CN.ts`（否则 `t("新key")` typecheck 报错），并加同 key 到 `en.ts` 保 parity。`keySeparator:false` → key 是**扁平整串**（`"reader.conversation.empty"` 是一个 key，不是嵌套）。
- **React Compiler 已启用**：不手写 `useCallback`/`useMemo`；但**命令式 effect（订阅/清理）仍手写**（见记忆 `marginalia-renderer-react-compiler`）。
- 工作目录：`/Users/wangjiyuan/dev/marginalia/.claude/worktrees/tender-jingling-wadler`，分支 `feat/conversations-tab`。勿 `cd` 原仓库根、勿 `git -C`。

---

## Task 1: i18n 文案键（zh-CN + en）

**Files:**

- Modify: `src/shared/i18n/locales/zh-CN.ts`
- Modify: `src/shared/i18n/locales/en.ts`

先加 key，解锁后续组件 typecheck。两文件均为**按 key 字母序排列的扁平对象**，把新键插入字母序对应位置（`reader.conversation.*` 在 `reader.bookSummary.*` 之后、`reader.conversations` 在其后；具体位置参照相邻 `reader.*` 键）。

- [ ] **Step 1: `zh-CN.ts` 加 6 个键**

在默认导出对象里加（值需与后续组件 `t(key, default)` 的 default 一致）：

```ts
  "reader.conversation.empty": "还没有会话。选段问 AI 试试～",
  "reader.conversation.independent": "独立会话",
  "reader.conversation.loadError": "会话加载失败",
  "reader.conversation.loading": "加载会话…",
  "reader.conversation.untitled": "未命名会话",
  "reader.conversations": "会话",
```

- [ ] **Step 2: `en.ts` 加同 6 个键**

```ts
  "reader.conversation.empty": "No conversations yet. Select some text and ask the AI.",
  "reader.conversation.independent": "Independent",
  "reader.conversation.loadError": "Failed to load conversations",
  "reader.conversation.loading": "Loading conversations…",
  "reader.conversation.untitled": "Untitled conversation",
  "reader.conversations": "Conversations",
```

- [ ] **Step 3: 验证**

Run: `pnpm typecheck`
Expected: PASS（zh-CN 的新键进入 `typeof zhCN` → t() 可用；此刻无消费方但类型 OK）。

- [ ] **Step 4: Commit**

```bash
git add src/shared/i18n/locales/zh-CN.ts src/shared/i18n/locales/en.ts
git commit -m "i18n(reader): add conversations tab strings (zh-CN/en)"
```

---

## Task 2: `deriveConversationTitle` 纯函数 + 测试

**Files:**

- Create: `src/main/chat/conversation-title.ts`
- Test: `src/main/chat/conversation-title.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/main/chat/conversation-title.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { deriveConversationTitle } from "@main/chat/conversation-title";

describe("deriveConversationTitle", () => {
  it("returns short single-line text as-is", () => {
    expect(deriveConversationTitle("关于灯塔的光")).toBe("关于灯塔的光");
  });
  it("takes the first non-empty line", () => {
    expect(deriveConversationTitle("\n  第一行  \n第二行")).toBe("第一行");
  });
  it("collapses inner whitespace", () => {
    expect(deriveConversationTitle("hello   world\t!")).toBe("hello world !");
  });
  it("truncates over 40 chars with ellipsis", () => {
    const long = "a".repeat(50);
    const out = deriveConversationTitle(long);
    expect(out).toBe("a".repeat(40) + "…");
    expect([...out].length).toBe(41);
  });
  it("returns empty string for blank input", () => {
    expect(deriveConversationTitle("   \n\t  ")).toBe("");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/chat/conversation-title.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

Create `src/main/chat/conversation-title.ts`:

```ts
const MAX_TITLE_LEN = 40;

/**
 * 由首条用户消息派生「随便起」的会话标题：取首个非空行、压缩内部空白、截断到 MAX_TITLE_LEN（超出加省略号）。
 * 全空白返回空串。未来「自动命名会话」功能将覆盖同一 title 字段。
 */
export function deriveConversationTitle(userText: string): string {
  const firstLine =
    userText
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const collapsed = firstLine.replace(/\s+/g, " ").trim();
  return [...collapsed].length <= MAX_TITLE_LEN
    ? collapsed
    : [...collapsed].slice(0, MAX_TITLE_LEN).join("") + "…";
}
```

> 用 `[...collapsed]` 按 Unicode 码点计数/切片（避免把代理对/中文截半）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/chat/conversation-title.test.ts`
Expected: PASS（5/5）。

- [ ] **Step 5: Commit**

```bash
git add src/main/chat/conversation-title.ts src/main/chat/conversation-title.test.ts
git commit -m "feat(chat): deriveConversationTitle (first-line truncate)"
```

---

## Task 3: `setConversationTitle` + 接入 `runSend`（首建会话落 title）

**Files:**

- Modify: `src/main/chat/conversations.ts`
- Modify: `src/main/chat/conversations.test.ts`
- Modify: `src/main/ai/send.ts`

- [ ] **Step 1: 在 `conversations.test.ts` 末尾追加 `setConversationTitle` 测试**

按该文件**已有的 `:memory:` DB + 书/assistant 播种 setup**（参照文件内 `routeConversation`/`createConversation` 测试的 fixture 构造方式）追加：

```ts
describe("setConversationTitle", () => {
  it("updates the title and is read back by getConversation", () => {
    // …复用本文件已有的建库 + 建书 + createConversation 设置，拿到 conv.id…
    const conv = createConversation(db, { bookId, chapterId });
    setConversationTitle(db, conv.id, "关于灯塔的光");
    expect(getConversation(db, conv.id)?.title).toBe("关于灯塔的光");
  });
});
```

并在文件顶部 import 里补 `setConversationTitle`（与现有 `createConversation`/`getConversation` 同处）。

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/chat/conversations.test.ts`
Expected: FAIL（`setConversationTitle` 未导出）。

- [ ] **Step 3: 实现 `setConversationTitle`**

在 `src/main/chat/conversations.ts` 加（紧邻 `getConversation`）：

```ts
/** 设置会话标题（首建会话落「随便起」标题 / 未来自动命名覆盖）。 */
export function setConversationTitle(db: DB, id: string, title: string): void {
  db.update(conversations).set({ title }).where(eq(conversations.id, id)).run();
}
```

（`db`/`conversations`/`eq` 文件顶部已 import。）

- [ ] **Step 4: 接入 `runSend`**

在 `src/main/ai/send.ts`：import 行补 `setConversationTitle` 与 `deriveConversationTitle`：

```ts
import { routeConversation, setConversationTitle } from "@main/chat/conversations";
import { deriveConversationTitle } from "@main/chat/conversation-title";
```

在 `const conversationId = route.conversationId;`（步骤 2 之后）下方插入：

```ts
// 首次创建会话时落「随便起」的标题（首条用户消息派生）；后续自动命名功能覆盖同字段。
if (route.created) {
  setConversationTitle(db, conversationId, deriveConversationTitle(input.userText));
}
```

- [ ] **Step 5: 全量验证**

Run: `pnpm typecheck && pnpm test src/main/chat/conversations.test.ts`
Expected: PASS（含新 `setConversationTitle` 测试；send 编译通过）。

- [ ] **Step 6: Commit**

```bash
git add src/main/chat/conversations.ts src/main/chat/conversations.test.ts src/main/ai/send.ts
git commit -m "feat(chat): setConversationTitle + set on first send (#conversations-tab)"
```

---

## Task 4: `messageDtoToUIMessage` 渲染层纯函数 + 测试

**Files:**

- Create: `src/renderer/ai/message-history.ts`
- Test: `src/renderer/ai/message-history.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/renderer/ai/message-history.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { MessageDto } from "@shared/chat";
import { messageDtoToUIMessage, messagesToUI } from "@renderer/ai/message-history";

const dto: MessageDto = {
  id: "m1",
  conversationId: "c1",
  role: "user",
  parts: [{ type: "text", text: "你好" }],
  metadata: { contextChips: [{ id: "selection", content: "x", tokenCount: 1 }] },
  status: "complete",
  seq: 0,
  createdAt: 1,
};

describe("messageDtoToUIMessage", () => {
  it("maps id/role/parts and omits metadata (MVP: no chip re-render)", () => {
    expect(messageDtoToUIMessage(dto)).toEqual({
      id: "m1",
      role: "user",
      parts: [{ type: "text", text: "你好" }],
    });
  });
  it("messagesToUI maps a list in order", () => {
    expect(messagesToUI([dto, { ...dto, id: "m2", role: "assistant" }]).map((m) => m.id)).toEqual([
      "m1",
      "m2",
    ]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/ai/message-history.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

Create `src/renderer/ai/message-history.ts`:

```ts
import type { MessageDto } from "@shared/chat";
import type { ChatUIMessage } from "@renderer/ai/types";

/**
 * 持久化 MessageDto → useChat 的 ChatUIMessage。
 * MVP 只取 id/role/parts：parts 本就是 UIMessage["parts"]，role(MessageRole) ⊆ UIMessage role；
 * 故意省略 metadata——持久化 metadata.contextChips 是快照投影（缺 labelKey），与 live ChatMetadata.contextChips(Chip[]) 不同型，
 * 历史只看 parts 即可（历史用户气泡不重渲 chip 徽标是 MVP 有意取舍）。
 */
export function messageDtoToUIMessage(dto: MessageDto): ChatUIMessage {
  return { id: dto.id, role: dto.role, parts: dto.parts };
}

export function messagesToUI(dtos: MessageDto[]): ChatUIMessage[] {
  return dtos.map(messageDtoToUIMessage);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/ai/message-history.test.ts`
Expected: PASS（2/2）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/ai/message-history.ts src/renderer/ai/message-history.test.ts
git commit -m "feat(ai): messageDtoToUIMessage history converter"
```

---

## Task 5: `relativeTime` 渲染层纯函数 + 测试

**Files:**

- Create: `src/renderer/lib/relative-time.ts`
- Test: `src/renderer/lib/relative-time.test.ts`

- [ ] **Step 1: 写失败测试**

Create `src/renderer/lib/relative-time.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import { relativeParts, relativeTime } from "@renderer/lib/relative-time";

const NOW = 1_000_000_000_000;
const sec = 1000;
const day = 86_400 * sec;

describe("relativeParts", () => {
  it("now → 0 seconds", () => {
    expect(relativeParts(NOW, NOW)).toEqual({ value: 0, unit: "second" });
  });
  it("30s ago → -30 second", () => {
    expect(relativeParts(NOW - 30 * sec, NOW)).toEqual({ value: -30, unit: "second" });
  });
  it("3 days ago → -3 day", () => {
    expect(relativeParts(NOW - 3 * day, NOW)).toEqual({ value: -3, unit: "day" });
  });
});

describe("relativeTime", () => {
  it("formats via Intl for a locale (non-empty)", () => {
    expect(relativeTime(NOW - 3 * day, NOW, "en")).toMatch(/3 days ago/);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/lib/relative-time.test.ts`
Expected: FAIL（模块不存在）。

- [ ] **Step 3: 实现**

Create `src/renderer/lib/relative-time.ts`:

```ts
const DIVISIONS: { amount: number; unit: Intl.RelativeTimeFormatUnit }[] = [
  { amount: 60, unit: "second" },
  { amount: 60, unit: "minute" },
  { amount: 24, unit: "hour" },
  { amount: 7, unit: "day" },
  { amount: 4.34524, unit: "week" },
  { amount: 12, unit: "month" },
  { amount: Number.POSITIVE_INFINITY, unit: "year" },
];

/** 选出相对时间的 {数值, 单位}（fromMs 过去 → 负值）。纯函数、可测，不碰 locale。 */
export function relativeParts(
  fromMs: number,
  nowMs: number,
): { value: number; unit: Intl.RelativeTimeFormatUnit } {
  let duration = (fromMs - nowMs) / 1000;
  for (const { amount, unit } of DIVISIONS) {
    if (Math.abs(duration) < amount) return { value: Math.round(duration), unit };
    duration /= amount;
  }
  return { value: Math.round(duration), unit: "year" };
}

/** 本地化相对时间串（如「3 天前」/"3 days ago"）。locale 取 i18n.language。 */
export function relativeTime(fromMs: number, nowMs: number, locale: string): string {
  const { value, unit } = relativeParts(fromMs, nowMs);
  return new Intl.RelativeTimeFormat(locale, { numeric: "auto" }).format(value, unit);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/renderer/lib/relative-time.test.ts`
Expected: PASS（4/4）。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/lib/relative-time.ts src/renderer/lib/relative-time.test.ts
git commit -m "feat(renderer): relativeTime helper (Intl.RelativeTimeFormat)"
```

---

## Task 6: chat-store 加 `openCommand` + `openConversation`

**Files:**

- Modify: `src/renderer/store/chat-store.ts`
- Modify: `src/renderer/store/chat-store.test.ts`

- [ ] **Step 1: 在 `chat-store.test.ts` 追加测试**

```ts
describe("openConversation", () => {
  it("sets active + opens panel + bumps openCommand nonce", () => {
    useChatStore.setState(CHAT_INITIAL);
    useChatStore.getState().openConversation("conv-1");
    const s1 = useChatStore.getState();
    expect(s1.activeConversationId).toBe("conv-1");
    expect(s1.panelOpen).toBe(true);
    expect(s1.openCommand).toEqual({ conversationId: "conv-1", nonce: 1 });
    useChatStore.getState().openConversation("conv-1");
    expect(useChatStore.getState().openCommand?.nonce).toBe(2); // 同会话重开也递增 → 触发重载
  });
});
```

（import 已有 `useChatStore`/`CHAT_INITIAL`；若文件无 `describe` import 按其现有风格。）

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/renderer/store/chat-store.test.ts`
Expected: FAIL（`openConversation` 未定义）。

- [ ] **Step 3: 实现**

改 `src/renderer/store/chat-store.ts` 为：

```ts
import { create } from "zustand";
import type { Chip } from "@shared/chat";

interface ChatState {
  activeConversationId: string | null;
  draftText: string;
  draftChips: Chip[];
  panelOpen: boolean;
  /**
   * 一次性命令信号（非状态）：nonce 递增触发 AIPanel 载入该会话历史。
   * 与 activeConversationId 解耦——发消息 ack 路径只设 activeConversationId、不发本命令，
   * 故发消息不会触发历史重载（避免覆盖刚流式出来的内容）。镜像 annotation-store.scrollCommand。
   */
  openCommand: { conversationId: string; nonce: number } | null;
}
interface ChatActions {
  setActiveConversation: (id: string | null) => void;
  setDraftText: (text: string) => void;
  setDraftChips: (chips: Chip[]) => void;
  setPanelOpen: (open: boolean) => void;
  /** 重开会话：发命令信号（触发载历史）+ 设 active（高亮）+ 开面板。 */
  openConversation: (id: string) => void;
}

export const CHAT_INITIAL: ChatState = {
  activeConversationId: null,
  draftText: "",
  draftChips: [],
  panelOpen: false,
  openCommand: null,
};

export const useChatStore = create<ChatState & ChatActions>((set) => ({
  ...CHAT_INITIAL,
  setActiveConversation: (activeConversationId) => set({ activeConversationId }),
  setDraftText: (draftText) => set({ draftText }),
  setDraftChips: (draftChips) => set({ draftChips }),
  setPanelOpen: (panelOpen) => set({ panelOpen }),
  openConversation: (id) =>
    set((s) => ({
      activeConversationId: id,
      panelOpen: true,
      openCommand: { conversationId: id, nonce: (s.openCommand?.nonce ?? 0) + 1 },
    })),
}));
```

- [ ] **Step 4: 跑测试 + typecheck**

Run: `pnpm typecheck && pnpm test src/renderer/store/chat-store.test.ts`
Expected: PASS。

- [ ] **Step 5: Commit**

```bash
git add src/renderer/store/chat-store.ts src/renderer/store/chat-store.test.ts
git commit -m "feat(store): chat openConversation + one-shot openCommand signal"
```

---

## Task 7: `ConversationsTab` 组件

**Files:**

- Create: `src/renderer/reader/ConversationsTab.tsx`

镜像 `AnnotationsList.tsx` 的列表模式（loading/error/empty/map + useQuery + 章节标题解析）。

- [ ] **Step 1: 创建组件**

Create `src/renderer/reader/ConversationsTab.tsx`:

```tsx
import { useTranslation } from "react-i18next";
import { useQuery } from "@tanstack/react-query";
import { MessagesSquare } from "lucide-react";
import type { ConversationDto } from "@shared/chat";
import type { ChapterRefDto } from "@shared/library";
import { cn } from "@renderer/lib/utils";
import { ScrollArea } from "@renderer/components/ui/scroll-area";
import { qk } from "@renderer/query/keys";
import { useChatStore } from "@renderer/store/chat-store";
import { relativeTime } from "@renderer/lib/relative-time";

export function ConversationsTab({ bookId }: { bookId: string }) {
  const { t, i18n } = useTranslation();
  const activeId = useChatStore((s) => s.activeConversationId);
  const openConversation = useChatStore((s) => s.openConversation);
  const convos = useQuery({
    queryKey: qk.conversations(bookId),
    queryFn: () => window.api.chat.conversations.listByBook({ bookId }),
  });
  const chapters = useQuery({
    queryKey: qk.chapters(bookId),
    queryFn: () => window.api.content.chapters({ bookId }),
  });

  if (convos.isPending)
    return (
      <p className="p-3 text-sm text-muted-foreground">
        {t("reader.conversation.loading", "加载会话…")}
      </p>
    );
  if (convos.isError)
    return (
      <p className="p-3 text-sm text-destructive">
        {t("reader.conversation.loadError", "会话加载失败")}
      </p>
    );
  const list = convos.data ?? [];
  if (list.length === 0)
    return (
      <p className="p-4 text-center text-xs text-muted-foreground">
        {t("reader.conversation.empty", "还没有会话。选段问 AI 试试～")}
      </p>
    );

  const chapterLabel = (c: ConversationDto): string => {
    if (c.kind === "independent") return t("reader.conversation.independent", "独立会话");
    const ch = (chapters.data ?? []).find((x: ChapterRefDto) => x.id === c.chapterId);
    return ch?.title ?? t("reader.conversation.independent", "独立会话");
  };
  // 主标签：title 优先；title 空时退章节标题（章节会话）/未命名（独立会话）。
  const primaryLabel = (c: ConversationDto): string =>
    c.title?.trim()
      ? c.title
      : c.kind === "chapter"
        ? chapterLabel(c)
        : t("reader.conversation.untitled", "未命名会话");
  const now = Date.now();

  return (
    <ScrollArea className="h-full">
      <div className="space-y-1 p-2">
        {list.map((c) => (
          <button
            key={c.id}
            type="button"
            onClick={() => openConversation(c.id)}
            className={cn(
              "flex w-full items-center gap-2 rounded-lg border border-transparent p-2 text-start",
              c.id === activeId ? "bg-accent" : "hover:bg-muted",
            )}
          >
            <MessagesSquare className="size-4 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-xs text-foreground">
              {primaryLabel(c)}
            </span>
            <span className="shrink-0 text-[10px] text-muted-foreground/70">{chapterLabel(c)}</span>
            <span className="shrink-0 text-[10px] text-muted-foreground/70">
              {relativeTime(c.updatedAt, now, i18n.language)}
            </span>
          </button>
        ))}
      </div>
    </ScrollArea>
  );
}
```

> 用 `<ScrollArea>`（main「自绘滚动条」交付后的统一滚动容器，同 `AnnotationsList`/`ChapterList`）包裹，不再用 `overflow-y-auto`。主标签 `min-w-0 flex-1 truncate`（单行省略号，spec §4.2 的 UI 截断要求）；副标签 `shrink-0` 不被压。章节用 `ch.id === c.chapterId` 解析（conversations.chapterId 引用 chapters 代理 id）。

- [ ] **Step 2: 验证编译/lint**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS（暂无消费方挂载，但模块编译通过；i18n key 已于 Task 1 就绪）。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/reader/ConversationsTab.tsx
git commit -m "feat(reader): ConversationsTab list (title/chapter/time, reopen click)"
```

---

## Task 8: Sidebar 加第三 tab + 选中才显文字 label

**Files:**

- Modify: `src/renderer/reader/Sidebar.tsx`

- [ ] **Step 1: 改写 `src/renderer/reader/Sidebar.tsx`**

```tsx
import { useTranslation } from "react-i18next";
import { List, Highlighter, MessagesSquare } from "lucide-react";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@renderer/components/ui/tabs";
import { BookCard } from "./BookCard";
import { ChapterList } from "./ChapterList";
import { AnnotationsList } from "./AnnotationsList";
import { ConversationsTab } from "./ConversationsTab";

export function Sidebar({ bookId }: { bookId: string }) {
  const { t } = useTranslation();
  // shadcn 的 tabs 组件用 data-horizontal/data-vertical 控方向/高度，但 Base UI Tabs.Root 发的是
  // data-orientation（属性名不匹配，那些类是惰性的）——故此处显式 flex-col + TabsList h-8 兜底。
  // tab label 仅在选中态显示（i18n 宽度适配）：trigger 标 group/tab，文字 span 用 group-data-[active] 显隐；
  // 未选中只剩图标，故每个 trigger 挂 aria-label 保可读名。
  return (
    <div className="flex h-full flex-col">
      <BookCard bookId={bookId} />
      <Tabs defaultValue="toc" className="min-h-0 flex-1 flex-col gap-0">
        <div className="shrink-0 border-b border-border p-1.5">
          <TabsList className="h-8 w-full">
            <TabsTrigger value="toc" className="group/tab" aria-label={t("reader.toc", "目录")}>
              <List />
              <span className="hidden group-data-[active]/tab:inline">
                {t("reader.toc", "目录")}
              </span>
            </TabsTrigger>
            <TabsTrigger
              value="notes"
              className="group/tab"
              aria-label={t("reader.annotations", "标注")}
            >
              <Highlighter />
              <span className="hidden group-data-[active]/tab:inline">
                {t("reader.annotations", "标注")}
              </span>
            </TabsTrigger>
            <TabsTrigger
              value="conversations"
              className="group/tab"
              aria-label={t("reader.conversations", "会话")}
            >
              <MessagesSquare />
              <span className="hidden group-data-[active]/tab:inline">
                {t("reader.conversations", "会话")}
              </span>
            </TabsTrigger>
          </TabsList>
        </div>
        <TabsContent value="toc" className="min-h-0 overflow-hidden">
          <ChapterList bookId={bookId} />
        </TabsContent>
        <TabsContent value="notes" className="min-h-0 overflow-hidden">
          <AnnotationsList bookId={bookId} />
        </TabsContent>
        <TabsContent value="conversations" className="min-h-0 overflow-hidden">
          <ConversationsTab bookId={bookId} />
        </TabsContent>
      </Tabs>
    </div>
  );
}
```

> `group-data-[active]/tab:inline`：Base UI 给选中的 `Tabs.Tab` 加 `data-active` 属性（现有 tabs.tsx 的 active 样式 `data-active:bg-background` 即靠它、且生效 → 属性确为 `data-active`）。trigger 标 `group/tab` 作命名组，文字 span 默认 `hidden`、仅当祖先 `.group/tab` 带 `data-active` 时 `inline`。

- [ ] **Step 2: 验证**

Run: `pnpm typecheck && pnpm lint`
Expected: PASS。

- [ ] **Step 3: 手测 tab label 行为**（可选但建议，留待 Task 11 一并冒烟）

`pnpm start` → 侧栏三 tab：未选中只图标、选中显「图标+文字」；切换正常。

- [ ] **Step 4: Commit**

```bash
git add src/renderer/reader/Sidebar.tsx
git commit -m "feat(reader): add conversations tab; show label only when tab active (i18n)"
```

---

## Task 9: AIPanel 接 `openCommand`（载历史）+ 发送后刷新列表

**Files:**

- Modify: `src/renderer/ai/AIPanel.tsx`

- [ ] **Step 1: 改 `src/renderer/ai/AIPanel.tsx`**

顶部 import 增加：

```ts
import { useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { messagesToUI } from "@renderer/ai/message-history";
```

（`useEffect`/`useMemo`/`useRef` 与 `ScrollArea` 已 import（后者 main 自绘滚动条交付时加）；只**新增** `useQueryClient`、`messagesToUI` 两个 import。）

替换组件函数体的 **hooks 区**（从 `export function AIPanel() {` 到 `newConversation` 定义为止），**保留其下 `return (...)` JSX 现状不变**——含 main 已迁入的 `<ScrollArea className="min-h-0 flex-1" viewportRef={scrollRef}>`（`scrollRef` 仍由本区声明并透传给它）。改后的 hooks 区：

```tsx
export function AIPanel() {
  const { t } = useTranslation();
  const transport = useMemo(() => createIpcChatTransport(), []);
  const { messages, sendMessage, status, stop, setMessages, error } = useChat<ChatUIMessage>({
    transport,
  });
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const setPanelOpen = useChatStore((s) => s.setPanelOpen);
  const openCommand = useChatStore((s) => s.openCommand);
  const qc = useQueryClient();
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const prevStatus = useRef(status);

  useEffect(() => {
    const el = scrollRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  }, [messages]);

  // 重开会话：openCommand.nonce 变 → 先中止在跑的流（避免增量灌入将被替换的历史、streamId 串台）→ 载历史 → setMessages。
  // 只认 openCommand（一次性命令信号），不认 activeConversationId——后者也被发消息 ack 写入，监听它会在发完消息后误重载。
  useEffect(() => {
    if (!openCommand) return;
    const { conversationId } = openCommand;
    let cancelled = false;
    stop();
    void window.api.chat.messages
      .listByConversation({ conversationId })
      .then((dtos) => {
        if (!cancelled) setMessages(messagesToUI(dtos));
      })
      .catch((err: unknown) => console.warn("[ai] load conversation history failed:", err));
    return () => {
      cancelled = true;
    };
  }, [openCommand, stop, setMessages]);

  // 一轮发送结束（曾 streaming/submitted → 回 ready/error）→ 刷新会话列表（新会话 / 标题 / updatedAt）。
  // 用前缀 ["conversations"] 失效（不需 bookId），匹配 qk.conversations(bookId)=["conversations",bookId]。
  useEffect(() => {
    if (prevStatus.current !== "ready" && (status === "ready" || status === "error")) {
      void qc.invalidateQueries({ queryKey: ["conversations"] });
    }
    prevStatus.current = status;
  }, [status, qc]);

  const newConversation = () => {
    setMessages([]);
    setActiveConversation(null);
  };
  // …（以下 return JSX 保持现状不变）…
```

> 两个 effect 均为命令式订阅/清理，React Compiler 不优化掉（见记忆）。`stop()` 无流在跑时是 no-op，安全。`["conversations"]` 前缀失效让任意 bookId 的会话列表刷新，AIPanel 不需感知 bookId。

- [ ] **Step 2: 验证**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: PASS（全量绿）。

- [ ] **Step 3: Commit**

```bash
git add src/renderer/ai/AIPanel.tsx
git commit -m "feat(ai): reopen conversation loads history via openCommand; refresh list on send settle"
```

---

## Task 10: ROADMAP 跨章 descope

**Files:**

- Modify: `docs/superpowers/ROADMAP.md`

仅 doc（无代码可删，`routeConversation` 为 scalar、全代码无 `chapterIds[]`）。

- [ ] **Step 1: 改 ROADMAP 四处跨章标记为砍掉**

- 「当前焦点」§下一目标候选行：删去「RA4 收尾（… / M-c 跨章）」里的「M-c 跨章」（保留全书摘要部分；该候选已多半完成）。
- 主进程表 `M-c` 行：状态 `🔴` → `🚫`，备注改「跨章会话 descoped（2026-06-04 用户决定砍掉，独立会话只经显式入口、无跨章选区路由）」。
- 渲染层表 `RA4` 行：名称「摘要查看 + 跨章会话」→「摘要查看」，状态 `🟡` → `✅`，备注去掉「跨章 🔴」。
- 接缝表「跨章选区 → 独立会话 + best-effort 组合摘要（M-c 的 UI 侧）」行：状态 `🔴` → `🚫`，备注追加「descoped（跨章砍掉）」。

定位用 `grep -n "M-c\|跨章\|RA4" docs/superpowers/ROADMAP.md`，逐行精确改（用 Read 取当前行原文再 Edit）。

- [ ] **Step 2: Commit**

```bash
git add docs/superpowers/ROADMAP.md
git commit -m "docs(roadmap): descope cross-chapter conversations (M-c / RA4 跨章)"
```

---

## Task 11: 全量门禁 + 端到端冒烟 + ROADMAP 交付登记

**Files:**

- Modify: `docs/superpowers/ROADMAP.md`

- [ ] **Step 1: 全量门禁**

Run: `pnpm typecheck && pnpm lint && pnpm test && pnpm i18n:lint`
Expected: 全绿；`i18n:lint` 确认 zh-CN/en parity（新 6 键齐）。补 grep 兜底（lint 可能漏报）：`grep -c "reader.conversation" src/shared/i18n/locales/zh-CN.ts src/shared/i18n/locales/en.ts` 两边一致。

- [ ] **Step 2: GUI 冒烟**

Run: `pnpm start`，逐项确认：

- 侧栏第三 tab「会话」出现；未选中只图标、选中显「图标+文字」；切到会话 tab。
- 对某章发一条消息 → 会话 tab 出现该会话（标题=首条消息截断、右侧章节名 + 相对时间）。
- 再对另一章发消息 → 列表新增第二条；时间/排序（updatedAt 倒序）正确。
- 点列表里第一条会话 → AI 面板载入其历史消息（不跳章）；active 行高亮。
- 重开会话后在同章继续发 → 接同一会话；标题长时行内单行省略号截断不撑破。

Expected: 全部正常，控制台无 `[ipc] … failed`、无 `load conversation history failed`。

- [ ] **Step 3: ROADMAP 交付登记**

在「当前焦点」区加一句（与既有同风格，日期 2026-06-04）：

```markdown
**会话 tab 已交付**（列表 + 重开，2026-06-04）：侧栏第三 tab「会话」——`listByBook` 列本书会话（标题/章节/相对时间，updatedAt 倒序），点击经一次性 `openCommand` 信号重开、载历史消息入 AI 面板（不监听 activeConversationId 避免 ack 串台、不跳章、in-flight 先 abort）。会话 title 在 `runSend` 首建时落「随便起」标题（首条消息截断，未来自动命名覆盖同字段）。TabsList 改「图标恒显 + 仅选中显文字 label」（i18n 宽度适配）+ aria-label。跨章会话已 descope。详见 `specs/2026-06-03-conversations-tab-design.md` / `plans/2026-06-04-conversations-tab.md`。
```

并在 backlog「设置/产品」或新条目记入未来项：**自动命名会话（LLM 依对话内容起名，覆盖 title 字段）** 🔴。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/ROADMAP.md
git commit -m "docs(roadmap): mark conversations tab delivered + backlog auto-naming"
```

- [ ] **Step 5: 收尾**

调用 `superpowers:finishing-a-development-branch`（rebase 到当前 main 保线性 → PR/合并，见记忆 `local-main-rebase-linear-workflow`）。

---

## 自审记录（实现者无需理会，供追溯）

- **Spec 覆盖**：§4.1 title 落库 → T2/T3；§4.2 tab UI + 选中显文字 + UI 截断 → T7/T8；§4.3 重开 openCommand + 载历史 + abort + 失效 → T6/T9；§4.4 主进程 setConversationTitle/derive → T2/T3；§6 测试 → T2/T3/T4/T5/T6（纯函数 + 仓库 + store）+ T11 手测；§7 跨章 descope → T10。
- **命令信号正确性**：重开只认 `openCommand`（T6/T9），ack 路径只动 `activeConversationId` → 发消息不重载历史（不串台）。
- **i18n**：key 先于消费方加（T1），由 `zh-CN.ts` 派生 t() 类型；en parity；T11 `i18n:lint`+grep 验。
- **绿色提交**：T1 先加 key 解锁后续 typecheck；纯函数/store（T2–T6）独立可测；组件（T7–T9）依赖前序，顺序就绪。
- **MVP 取舍**：历史用户气泡不重渲 chip 徽标（metadata 省略，T4）；相对时间用 Intl（T5）。
- **tab 选中显隐**依赖 Base UI `data-active`（T8，由现有 tabs.tsx 样式实证）；若实测属性名不符，改 `group-data-[selected]/tab`。
