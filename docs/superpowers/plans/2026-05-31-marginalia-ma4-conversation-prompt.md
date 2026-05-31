# MA4 · 会话编排与 Prompt 组装（确定性层）Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在 main 侧实现「核心阅读闭环」AI 编排的**确定性数据 / Prompt 层**——会话与消息持久化、章节驱动的会话路由、上下文 chip 构建与 token 估算、段落去重、以及把分层上下文组装成 `ModelMessage[]`——全部为注入 `DB` 的纯函数，零模型调用、零 Electron 依赖，可在 vitest 下完整 headless 测试。

**Architecture:** 沿用既有「纯业务函数 + 胶水层注入」端口模式（参见 `src/main/library/*`、`src/main/providers/*`）。新增 `src/main/chat/`（会话/消息仓库 + 路由）与 `src/main/ai/`（token 估算、chip 构建、prompt 组装）两组纯函数模块，经 `src/main/ipc/chat-handlers.ts` 注入 `getDb()` 暴露只读 / 显式创建通道。Zod 契约集中在新建的 `src/shared/chat.ts`。**MA5（流式层）**将复用本里程碑的 `routeConversation` / `assemblePrompt` / `dedupeParagraph` / `appendMessage` / `getLastParagraphContent` 拼出 `ai.send`（`streamText` + tools + agent 循环 + 完成落库），并新增章节摘要懒生成——本计划不含任何 `streamText` / 模型调用。

**Tech Stack:** TypeScript 6（strict）、Drizzle ORM 1.0.0-rc.3 + better-sqlite3（`:memory:` 测试）、Zod 4、Vercel AI SDK v6（仅 `import type { ModelMessage, UIMessage } from "ai"`，纯类型，无运行时调用）、vitest 4。

---

## 设计判定（实现者必读）

这些判定直接来自 `docs/superpowers/specs/2026-05-31-marginalia-core-reading-loop-design.md`（下称「设计文档」），实现时严格遵循：

1. **消息持久化形态（设计文档 §5、§9 step 6）**：持久化的 user `UIMessage` 的 `parts` 只存**用户输入的纯文本**（气泡里显示的内容）；选区 / 段落上下文以**快照**形式存入 `metadata.contextChips`（形如 `{ id, content, tokenCount }`，schema 已在 `messageMetadataSchema` 定义）。**不**把上下文文本烘焙进 `parts`。

2. **历史上下文「原样带」（设计文档 §10）**：发送时不直接 `convertToModelMessages`，而是逐条重建——每个历史 user 轮次从它自己的 `metadata.contextChips` 重新展开段落 / 选区上下文。`assemblePrompt` 因此是一个读取「历史行 + 当前轮」的纯函数。本里程碑 assistant 消息仅含 text part；MA5 处理工具 part 时再扩展 assistant 侧转换。

3. **章节摘要只随当前轮注入一次（设计文档 §10）**：章节摘要是会话级共享、反映当前状态，故仅拼进**当前** user 轮次的上下文块（历史 user 轮次只带各自的选区 / 段落，不重复摘要）。

4. **`routeConversation` 有副作用，不作为独立 IPC（设计文档 §6、§9）**：路由可能**创建**会话，只能由 MA5 的 `ai.send` 内部调用（确定要发送时才创建），避免「点了选区又不发」留下孤儿会话。本里程碑把它实现为受测纯函数 / 仓库函数，但**不**接 IPC。选区路由只指向**章节会话**；独立会话（`chapterId = NULL`）仅经显式 `conversations:create` 入口创建。

5. **token 估算用启发式，无 tokenizer 依赖**：chip 上的 token 数仅供用户参考（设计文档 §7/§10），不要求与某家 provider 精确一致。CJK 字符 ≈ 1 token，其余 ≈ 4 字符 / token。后续如需精确再换真 tokenizer。

6. **零 schema 改动**：`conversations` / `messages` / `chapters`（摘要字段）已在 `src/main/db/schema.ts` 就位，`messageMetadataSchema.contextChips` 已定义。本里程碑不跑 `pnpm db:generate`。

**MA4 IPC 暴露面**（其余为内部受测函数）：`conversations:list-by-book`、`conversations:create`、`conversations:get`、`messages:list-by-conversation`、`ai:build-chips`。`preload.ts` 接线延后到 UI 轨（沿用 MA1-MA3 惯例）。

---

## 文件结构

| 文件                             | 职责                                                                                                                                                              | 任务 |
| -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `src/shared/chat.ts`             | Zod 单一事实源：`chipSchema`、`buildChipsInput`、`createConversationInput`、`conversationIdInput`、`messagesByConversationInput`、`ConversationDto`、`MessageDto` | 1    |
| `src/main/ai/tokens.ts`          | `estimateTokens(text)` 启发式估算                                                                                                                                 | 2    |
| `src/main/ai/chips.ts`           | `buildChips(input)`、`dedupeParagraph(chips, prev)`                                                                                                               | 3    |
| `src/main/chat/messages.ts`      | 消息仓库：`appendMessage`、`listMessages`、`getLastParagraphContent`                                                                                              | 4    |
| `src/main/chat/conversations.ts` | 会话仓库 + 路由：`createConversation`、`getConversation`、`listConversationsByBook`、`routeConversation`                                                          | 5    |
| `src/main/ai/prompt.ts`          | `assemblePrompt(params)` → `ModelMessage[]`（含 `renderUserTurn` / `textOfParts` 等私有助手）                                                                     | 6    |
| `src/shared/ipc.ts`（改）        | 新增 5 个通道名                                                                                                                                                   | 7    |
| `src/main/ipc/chat-handlers.ts`  | `registerChatHandlers()` 注入 `getDb()` 接 5 通道                                                                                                                 | 7    |
| `src/main.ts`（改）              | 调用 `registerChatHandlers()`                                                                                                                                     | 7    |

每个 `*.ts` 配套 `*.test.ts`（除 `chat-handlers.ts`，沿用 `settings-handlers.ts` 无专测、靠 typecheck 兜底的惯例）。

---

## Task 1: shared/chat.ts —— Zod 契约与 DTO

**Files:**

- Create: `src/shared/chat.ts`
- Test: `src/shared/chat.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/shared/chat.test.ts
import { describe, expect, it } from "vitest";
import {
  buildChipsInput,
  chipSchema,
  createConversationInput,
  messagesByConversationInput,
} from "@shared/chat";

describe("chat schemas", () => {
  it("chipSchema accepts a well-formed selection chip", () => {
    const chip = {
      id: "selection",
      labelKey: "chip.selection",
      content: "hello",
      tokenCount: 2,
      required: true,
      enabled: true,
    };
    expect(chipSchema.parse(chip)).toEqual(chip);
  });

  it("chipSchema rejects an unknown chip id", () => {
    const r = chipSchema.safeParse({
      id: "chapter",
      labelKey: "x",
      content: "y",
      tokenCount: 0,
      required: true,
      enabled: true,
    });
    expect(r.success).toBe(false);
  });

  it("chipSchema rejects a negative tokenCount", () => {
    const r = chipSchema.safeParse({
      id: "selection",
      labelKey: "x",
      content: "y",
      tokenCount: -1,
      required: true,
      enabled: true,
    });
    expect(r.success).toBe(false);
  });

  it("buildChipsInput requires a non-empty selection and current paragraph", () => {
    expect(buildChipsInput.safeParse({ selection: "", paragraphCurrent: "p" }).success).toBe(false);
    expect(buildChipsInput.safeParse({ selection: "s", paragraphCurrent: "p" }).success).toBe(true);
  });

  it("createConversationInput allows a null chapterId (independent conversation)", () => {
    expect(createConversationInput.safeParse({ bookId: "b", chapterId: null }).success).toBe(true);
    expect(createConversationInput.safeParse({ bookId: "", chapterId: null }).success).toBe(false);
  });

  it("messagesByConversationInput requires a non-empty conversationId", () => {
    expect(messagesByConversationInput.safeParse({ conversationId: "" }).success).toBe(false);
    expect(messagesByConversationInput.safeParse({ conversationId: "c" }).success).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/shared/chat.test.ts`
Expected: FAIL —— `Cannot find module '@shared/chat'`（文件尚未创建）。

- [ ] **Step 3: 实现 `src/shared/chat.ts`**

```ts
// src/shared/chat.ts
import { z } from "zod";
import type { UIMessage } from "ai";
import type { MessageMetadata } from "@shared/types";

/** 上下文 chip（live 形态，供 renderer 渲染；持久化快照只取 {id,content,tokenCount}，见 messageMetadataSchema） */
export const chipSchema = z.object({
  id: z.enum(["selection", "paragraph"]),
  labelKey: z.string(),
  content: z.string(),
  tokenCount: z.number().int().nonnegative(),
  required: z.boolean(),
  enabled: z.boolean(),
});
export type Chip = z.infer<typeof chipSchema>;

/** ai:build-chips 入参——renderer 提取的选区原句 + 前1/当前/后1 段原始文本 */
export const buildChipsInput = z.object({
  selection: z.string().min(1),
  paragraphBefore: z.string().nullish(),
  paragraphCurrent: z.string(),
  paragraphAfter: z.string().nullish(),
});
export type BuildChipsInput = z.infer<typeof buildChipsInput>;

/** conversations:create 入参——chapterId 传 null 表示显式「独立会话」 */
export const createConversationInput = z.object({
  bookId: z.string().min(1),
  chapterId: z.string().min(1).nullable(),
});
export type CreateConversationInput = z.infer<typeof createConversationInput>;

/** conversations:get 入参 */
export const conversationIdInput = z.object({ id: z.string().min(1) });
export type ConversationIdInput = z.infer<typeof conversationIdInput>;

/** messages:list-by-conversation 入参 */
export const messagesByConversationInput = z.object({ conversationId: z.string().min(1) });
export type MessagesByConversationInput = z.infer<typeof messagesByConversationInput>;

export interface ConversationDto {
  id: string;
  bookId: string | null;
  chapterId: string | null;
  assistantId: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface MessageDto {
  id: string;
  conversationId: string;
  role: "system" | "user" | "assistant";
  parts: UIMessage["parts"];
  metadata: MessageMetadata | null;
  seq: number;
  createdAt: number;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/shared/chat.test.ts`
Expected: PASS（6 测试全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/shared/chat.ts src/shared/chat.test.ts
git commit -m "feat(ma4): add shared Zod contracts for chat (chips, conversations, messages)"
```

---

## Task 2: ai/tokens.ts —— token 启发式估算

**Files:**

- Create: `src/main/ai/tokens.ts`
- Test: `src/main/ai/tokens.test.ts`

- [ ] **Step 1: 写失败测试**

```ts
// src/main/ai/tokens.test.ts
import { describe, expect, it } from "vitest";
import { estimateTokens } from "@main/ai/tokens";

describe("estimateTokens", () => {
  it("returns 0 for an empty string", () => {
    expect(estimateTokens("")).toBe(0);
  });

  it("counts CJK characters as ~1 token each", () => {
    // 4 个汉字 → 4 token
    expect(estimateTokens("你好世界")).toBe(4);
  });

  it("counts non-CJK as ~4 chars per token (ceil)", () => {
    // 8 个 ASCII → ceil(8/4) = 2
    expect(estimateTokens("abcdefgh")).toBe(2);
    // 5 个 ASCII → ceil(5/4) = 2
    expect(estimateTokens("abcde")).toBe(2);
  });

  it("mixes CJK and ASCII additively", () => {
    // 2 汉字 + 4 ASCII → 2 + ceil(4/4)=2 → 总 ceil(2 + 1) = 3
    expect(estimateTokens("你好abcd")).toBe(3);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/tokens.test.ts`
Expected: FAIL —— `Cannot find module '@main/ai/tokens'`。

- [ ] **Step 3: 实现 `src/main/ai/tokens.ts`**

```ts
// src/main/ai/tokens.ts

// 覆盖常见 CJK 区段：标点/符号(3000-303f)、扩展A(3400-4dbf)、统一汉字(4e00-9fff)、
// 兼容汉字(f900-faff)、全角及半角形式(ff00-ffef)。命中即按 ~1 token 估算。
const CJK = /[　-〿㐀-䶿一-鿿豈-﫿＀-￯]/;

/**
 * 粗略 token 估算（无 tokenizer 依赖，仅供 chip 信息展示）。
 * CJK 字符按 ~1 token；其余按 ~4 字符 / token。后续如需精确再换真 tokenizer。
 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk++;
    else other++;
  }
  return Math.ceil(cjk + other / 4);
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/ai/tokens.test.ts`
Expected: PASS（4 测试全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/tokens.ts src/main/ai/tokens.test.ts
git commit -m "feat(ma4): add heuristic token estimator"
```

---

## Task 3: ai/chips.ts —— chip 构建与段落去重

**Files:**

- Create: `src/main/ai/chips.ts`
- Test: `src/main/ai/chips.test.ts`

设计文档 §7/§9：`buildChips` 是纯 token 计数 + chip 构造，**不含**会话上下文（去重在装配时单独做）。段落 chip 内容 = 前/当前/后段去空白后用空行连接。`dedupeParagraph` 把内容与「上一次插入的段落」相同的段落 chip 剔除（设计文档 §6）。

- [ ] **Step 1: 写失败测试**

```ts
// src/main/ai/chips.test.ts
import { describe, expect, it } from "vitest";
import { buildChips, dedupeParagraph } from "@main/ai/chips";

describe("buildChips", () => {
  it("builds a selection chip and a paragraph chip", () => {
    const chips = buildChips({
      selection: "the cat sat",
      paragraphBefore: "before.",
      paragraphCurrent: "the cat sat on the mat.",
      paragraphAfter: "after.",
    });
    expect(chips.map((c) => c.id)).toEqual(["selection", "paragraph"]);
    const selection = chips[0];
    expect(selection).toMatchObject({
      id: "selection",
      labelKey: "chip.selection",
      content: "the cat sat",
      required: true,
      enabled: true,
    });
    expect(selection.tokenCount).toBeGreaterThan(0);
    // 段落 = before + current + after，用空行连接
    expect(chips[1].content).toBe("before.\n\nthe cat sat on the mat.\n\nafter.");
  });

  it("omits the paragraph chip when there is no paragraph text", () => {
    const chips = buildChips({
      selection: "lone selection",
      paragraphBefore: null,
      paragraphCurrent: "   ",
      paragraphAfter: null,
    });
    expect(chips.map((c) => c.id)).toEqual(["selection"]);
  });

  it("trims selection and paragraph pieces", () => {
    const chips = buildChips({
      selection: "  trimmed  ",
      paragraphCurrent: "  only current  ",
    });
    expect(chips[0].content).toBe("trimmed");
    expect(chips[1].content).toBe("only current");
  });
});

describe("dedupeParagraph", () => {
  const sample = buildChips({
    selection: "s",
    paragraphCurrent: "shared paragraph",
  });

  it("returns chips unchanged when there is no previous paragraph", () => {
    expect(dedupeParagraph(sample, null)).toEqual(sample);
  });

  it("drops the paragraph chip when its content matches the previous one", () => {
    const result = dedupeParagraph(sample, "shared paragraph");
    expect(result.map((c) => c.id)).toEqual(["selection"]);
  });

  it("keeps the paragraph chip when content differs", () => {
    const result = dedupeParagraph(sample, "a different paragraph");
    expect(result.map((c) => c.id)).toEqual(["selection", "paragraph"]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/chips.test.ts`
Expected: FAIL —— `Cannot find module '@main/ai/chips'`。

- [ ] **Step 3: 实现 `src/main/ai/chips.ts`**

```ts
// src/main/ai/chips.ts
import { estimateTokens } from "@main/ai/tokens";
import type { BuildChipsInput, Chip } from "@shared/chat";

/** 由 renderer 提取的原始文本构造 selection / paragraph chip（不含会话上下文；去重见 dedupeParagraph）。 */
export function buildChips(input: BuildChipsInput): Chip[] {
  const chips: Chip[] = [];

  const selection = input.selection.trim();
  chips.push({
    id: "selection",
    labelKey: "chip.selection",
    content: selection,
    tokenCount: estimateTokens(selection),
    required: true,
    enabled: true,
  });

  const paragraph = [input.paragraphBefore, input.paragraphCurrent, input.paragraphAfter]
    .map((p) => p?.trim())
    .filter((p): p is string => !!p)
    .join("\n\n");
  if (paragraph) {
    chips.push({
      id: "paragraph",
      labelKey: "chip.paragraph",
      content: paragraph,
      tokenCount: estimateTokens(paragraph),
      required: true,
      enabled: true,
    });
  }

  return chips;
}

/** 段落去重（设计文档 §6）：段落内容与本会话上一次插入的相同则省略该段落 chip。 */
export function dedupeParagraph(chips: Chip[], previousParagraph: string | null): Chip[] {
  if (previousParagraph == null) return chips;
  return chips.filter((c) => !(c.id === "paragraph" && c.content === previousParagraph));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/ai/chips.test.ts`
Expected: PASS（6 测试全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/chips.ts src/main/ai/chips.test.ts
git commit -m "feat(ma4): add chip builder and paragraph dedup"
```

---

## Task 4: chat/messages.ts —— 消息仓库

**Files:**

- Create: `src/main/chat/messages.ts`
- Test: `src/main/chat/messages.test.ts`

`appendMessage` 在事务内计算下一 `seq`（`max(seq)+1`，空会话从 0 起）、插入消息、并 bump `conversations.updatedAt`。`getLastParagraphContent` 倒序找最近一条**带段落 chip**的 user 消息，返回其段落内容（供 MA5 的去重；设计文档 §6「上一次插入的」）。

测试用直接 `db.insert` 播种 `books` / `conversations`（满足外键），不依赖其它仓库函数。

- [ ] **Step 1: 写失败测试**

```ts
// src/main/chat/messages.test.ts
import path from "node:path";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { books, conversations } from "@main/db/schema";
import { appendMessage, getLastParagraphContent, listMessages } from "@main/chat/messages";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

function seedConversation(db: ReturnType<typeof freshDb>): string {
  db.insert(books).values({ id: "book-1", path: "/tmp/a.epub" }).run();
  const row = db
    .insert(conversations)
    .values({ bookId: "book-1", chapterId: null, assistantId: null })
    .returning()
    .get();
  return row.id;
}

describe("appendMessage / listMessages", () => {
  it("assigns monotonically increasing seq starting at 0", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    const m0 = appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    const m1 = appendMessage(db, {
      conversationId: cid,
      role: "assistant",
      parts: [{ type: "text", text: "hello" }],
    });
    expect(m0.seq).toBe(0);
    expect(m1.seq).toBe(1);
    const all = listMessages(db, cid);
    expect(all.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(all.map((m) => m.seq)).toEqual([0, 1]);
  });

  it("persists metadata.contextChips and returns it via listMessages", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "what is this?" }],
      metadata: {
        contextChips: [{ id: "selection", content: "the cat", tokenCount: 2 }],
      },
    });
    const [msg] = listMessages(db, cid);
    expect(msg.metadata?.contextChips?.[0]).toEqual({
      id: "selection",
      content: "the cat",
      tokenCount: 2,
    });
  });

  it("bumps conversations.updatedAt on append", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    const before = db
      .select()
      .from(conversations)
      .all()
      .find((c) => c.id === cid)!.updatedAt;
    // 直接改回一个更早的时间，确保 append 会推进它
    db.update(conversations)
      .set({ updatedAt: before - 10_000 })
      .run();
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "x" }],
    });
    const after = db
      .select()
      .from(conversations)
      .all()
      .find((c) => c.id === cid)!.updatedAt;
    expect(after).toBeGreaterThan(before - 10_000);
  });
});

describe("getLastParagraphContent", () => {
  it("returns null when no user message carries a paragraph chip", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "no chips" }],
    });
    expect(getLastParagraphContent(db, cid)).toBeNull();
  });

  it("returns the most recently inserted paragraph content, skipping turns without one", () => {
    const db = freshDb();
    const cid = seedConversation(db);
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "first" }],
      metadata: { contextChips: [{ id: "paragraph", content: "para A", tokenCount: 1 }] },
    });
    appendMessage(db, {
      conversationId: cid,
      role: "assistant",
      parts: [{ type: "text", text: "ok" }],
    });
    // 后一轮段落被去重（无 paragraph chip），应回退到 para A
    appendMessage(db, {
      conversationId: cid,
      role: "user",
      parts: [{ type: "text", text: "second" }],
      metadata: { contextChips: [{ id: "selection", content: "sel", tokenCount: 1 }] },
    });
    expect(getLastParagraphContent(db, cid)).toBe("para A");
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/chat/messages.test.ts`
Expected: FAIL —— `Cannot find module '@main/chat/messages'`。

- [ ] **Step 3: 实现 `src/main/chat/messages.ts`**

```ts
// src/main/chat/messages.ts
import { desc, eq, max } from "drizzle-orm";
import type { UIMessage } from "ai";
import type { DB } from "@main/db/client";
import { conversations, messages } from "@main/db/schema";
import type { MessageDto } from "@shared/chat";
import type { MessageMetadata } from "@shared/types";

type MessageRow = typeof messages.$inferSelect;

function toDto(row: MessageRow): MessageDto {
  return {
    id: row.id,
    conversationId: row.conversationId,
    role: row.role,
    parts: row.parts,
    metadata: row.metadata ?? null,
    seq: row.seq,
    createdAt: row.createdAt,
  };
}

export interface AppendMessageInput {
  conversationId: string;
  role: "system" | "user" | "assistant";
  parts: UIMessage["parts"];
  metadata?: MessageMetadata | null;
}

/** 追加一条消息：事务内取下一 seq、插入、并推进 conversations.updatedAt。 */
export function appendMessage(db: DB, input: AppendMessageInput): MessageDto {
  return db.transaction((tx) => {
    const top = tx
      .select({ m: max(messages.seq) })
      .from(messages)
      .where(eq(messages.conversationId, input.conversationId))
      .get();
    const nextSeq = (top?.m ?? -1) + 1;

    const inserted = tx
      .insert(messages)
      .values({
        conversationId: input.conversationId,
        role: input.role,
        parts: input.parts,
        metadata: input.metadata ?? null,
        seq: nextSeq,
      })
      .returning()
      .get();

    tx.update(conversations)
      .set({ updatedAt: Date.now() })
      .where(eq(conversations.id, input.conversationId))
      .run();

    return toDto(inserted);
  });
}

/** 按 seq 升序列出会话内全部消息。 */
export function listMessages(db: DB, conversationId: string): MessageDto[] {
  return db
    .select()
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(messages.seq)
    .all()
    .map(toDto);
}

/** 倒序找最近一条带段落 chip 的 user 消息，返回其段落内容（设计文档 §6「上一次插入的」）；无则 null。 */
export function getLastParagraphContent(db: DB, conversationId: string): string | null {
  const rows = db
    .select({ role: messages.role, metadata: messages.metadata })
    .from(messages)
    .where(eq(messages.conversationId, conversationId))
    .orderBy(desc(messages.seq))
    .all();
  for (const r of rows) {
    if (r.role !== "user") continue;
    const para = r.metadata?.contextChips?.find((c) => c.id === "paragraph");
    if (para) return para.content;
  }
  return null;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/chat/messages.test.ts`
Expected: PASS（5 测试全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/main/chat/messages.ts src/main/chat/messages.test.ts
git commit -m "feat(ma4): add message repository (append with seq, list, last-paragraph)"
```

---

## Task 5: chat/conversations.ts —— 会话仓库与路由

**Files:**

- Create: `src/main/chat/conversations.ts`
- Test: `src/main/chat/conversations.test.ts`

`routeConversation`（设计文档 §6）：

- 活动会话存在、且同书、且（独立 `chapterId=null` 或绑定当前章）→ 追加，`{ created:false, switchedFromActive:false }`。
- 否则在当前章找最近一条会话；有则切到（`created:false`），无则新建（`created:true`）。这两种情形若原本有活动会话，则 `switchedFromActive:true`（供 UI 提示「已为《第 N 章》开启会话」）。

选区路由只指向章节会话；`createConversation` 在创建时把 `assistantId` 设为默认 Assistant（`getDefaultAssistant` 会按需惰性播种）。

- [ ] **Step 1: 写失败测试**

```ts
// src/main/chat/conversations.test.ts
import path from "node:path";
import { eq } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";
import { books, chapters, conversations } from "@main/db/schema";
import {
  createConversation,
  getConversation,
  listConversationsByBook,
  routeConversation,
} from "@main/chat/conversations";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  return db;
}

function seedBookWithChapters(db: ReturnType<typeof freshDb>) {
  db.insert(books).values({ id: "book-1", path: "/tmp/a.epub" }).run();
  const ch1 = db
    .insert(chapters)
    .values({ bookId: "book-1", href: "c1.html", orderIndex: 0, title: "Ch 1" })
    .returning()
    .get();
  const ch2 = db
    .insert(chapters)
    .values({ bookId: "book-1", href: "c2.html", orderIndex: 1, title: "Ch 2" })
    .returning()
    .get();
  return { ch1: ch1.id, ch2: ch2.id };
}

describe("createConversation / getConversation / listConversationsByBook", () => {
  it("creates a conversation bound to the default assistant", () => {
    const db = freshDb();
    seedBookWithChapters(db);
    const convo = createConversation(db, { bookId: "book-1", chapterId: null });
    expect(convo.bookId).toBe("book-1");
    expect(convo.chapterId).toBeNull();
    expect(convo.assistantId).not.toBeNull();
    expect(getConversation(db, convo.id)?.id).toBe(convo.id);
  });

  it("getConversation returns null for an unknown id", () => {
    const db = freshDb();
    expect(getConversation(db, "nope")).toBeNull();
  });

  it("lists conversations for a book most-recently-updated first", () => {
    const db = freshDb();
    const { ch1, ch2 } = seedBookWithChapters(db);
    const a = createConversation(db, { bookId: "book-1", chapterId: ch1 });
    const b = createConversation(db, { bookId: "book-1", chapterId: ch2 });
    // 显式设定不同 updatedAt，避免同毫秒打平导致排序不确定
    db.update(conversations).set({ updatedAt: 1 }).where(eq(conversations.id, a.id)).run();
    db.update(conversations).set({ updatedAt: 2 }).where(eq(conversations.id, b.id)).run();
    const list = listConversationsByBook(db, "book-1");
    expect(list.map((c) => c.id)).toEqual([b.id, a.id]);
  });
});

describe("routeConversation", () => {
  it("creates a new chapter conversation when none exists and there is no active one", () => {
    const db = freshDb();
    const { ch1 } = seedBookWithChapters(db);
    const r = routeConversation(db, {
      bookId: "book-1",
      currentChapterId: ch1,
      activeConversationId: null,
    });
    expect(r.created).toBe(true);
    expect(r.switchedFromActive).toBe(false);
    expect(getConversation(db, r.conversationId)?.chapterId).toBe(ch1);
  });

  it("appends to the active conversation when it is bound to the current chapter", () => {
    const db = freshDb();
    const { ch1 } = seedBookWithChapters(db);
    const active = createConversation(db, { bookId: "book-1", chapterId: ch1 });
    const r = routeConversation(db, {
      bookId: "book-1",
      currentChapterId: ch1,
      activeConversationId: active.id,
    });
    expect(r).toEqual({ conversationId: active.id, created: false, switchedFromActive: false });
  });

  it("appends to the active conversation when it is independent (chapterId null)", () => {
    const db = freshDb();
    const { ch1 } = seedBookWithChapters(db);
    const active = createConversation(db, { bookId: "book-1", chapterId: null });
    const r = routeConversation(db, {
      bookId: "book-1",
      currentChapterId: ch1,
      activeConversationId: active.id,
    });
    expect(r.conversationId).toBe(active.id);
    expect(r.switchedFromActive).toBe(false);
  });

  it("switches away from an active conversation bound to a different chapter (creating if needed)", () => {
    const db = freshDb();
    const { ch1, ch2 } = seedBookWithChapters(db);
    const active = createConversation(db, { bookId: "book-1", chapterId: ch2 });
    const r = routeConversation(db, {
      bookId: "book-1",
      currentChapterId: ch1,
      activeConversationId: active.id,
    });
    expect(r.conversationId).not.toBe(active.id);
    expect(r.created).toBe(true);
    expect(r.switchedFromActive).toBe(true);
    expect(getConversation(db, r.conversationId)?.chapterId).toBe(ch1);
  });

  it("switches to an existing chapter conversation rather than creating a duplicate", () => {
    const db = freshDb();
    const { ch1, ch2 } = seedBookWithChapters(db);
    const existing = createConversation(db, { bookId: "book-1", chapterId: ch1 });
    const active = createConversation(db, { bookId: "book-1", chapterId: ch2 });
    const r = routeConversation(db, {
      bookId: "book-1",
      currentChapterId: ch1,
      activeConversationId: active.id,
    });
    expect(r.conversationId).toBe(existing.id);
    expect(r.created).toBe(false);
    expect(r.switchedFromActive).toBe(true);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/chat/conversations.test.ts`
Expected: FAIL —— `Cannot find module '@main/chat/conversations'`。

- [ ] **Step 3: 实现 `src/main/chat/conversations.ts`**

```ts
// src/main/chat/conversations.ts
import { and, desc, eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { conversations } from "@main/db/schema";
import { getDefaultAssistant } from "@main/providers/assistant";
import type { ConversationDto, CreateConversationInput } from "@shared/chat";

type ConversationRow = typeof conversations.$inferSelect;

function toDto(row: ConversationRow): ConversationDto {
  return {
    id: row.id,
    bookId: row.bookId ?? null,
    chapterId: row.chapterId ?? null,
    assistantId: row.assistantId ?? null,
    title: row.title ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** 创建会话（chapterId 传 null = 独立会话）；assistantId 取默认 Assistant（按需惰性播种）。 */
export function createConversation(db: DB, input: CreateConversationInput): ConversationDto {
  const assistant = getDefaultAssistant(db);
  const row = db
    .insert(conversations)
    .values({ bookId: input.bookId, chapterId: input.chapterId, assistantId: assistant.id })
    .returning()
    .get();
  return toDto(row);
}

export function getConversation(db: DB, id: string): ConversationDto | null {
  const row = db.select().from(conversations).where(eq(conversations.id, id)).get();
  return row ? toDto(row) : null;
}

/** 列出某书的会话，最近更新在前。 */
export function listConversationsByBook(db: DB, bookId: string): ConversationDto[] {
  return db
    .select()
    .from(conversations)
    .where(eq(conversations.bookId, bookId))
    .orderBy(desc(conversations.updatedAt))
    .all()
    .map(toDto);
}

export interface RouteParams {
  bookId: string;
  currentChapterId: string;
  activeConversationId: string | null;
}

export interface RouteDecision {
  conversationId: string;
  created: boolean;
  switchedFromActive: boolean;
}

/**
 * 划词 → 会话路由（设计文档 §6）。仅指向章节会话；独立会话只经显式入口创建。
 * 有副作用（可能创建会话），故只由 MA5 的 ai.send 内部在确定发送时调用，不接 IPC。
 */
export function routeConversation(db: DB, params: RouteParams): RouteDecision {
  if (params.activeConversationId) {
    const active = db
      .select()
      .from(conversations)
      .where(eq(conversations.id, params.activeConversationId))
      .get();
    // 活动会话同书、且独立或绑定当前章 → 追加
    if (
      active &&
      active.bookId === params.bookId &&
      (active.chapterId === null || active.chapterId === params.currentChapterId)
    ) {
      return { conversationId: active.id, created: false, switchedFromActive: false };
    }
  }

  const switchedFromActive = params.activeConversationId != null;

  const existing = db
    .select()
    .from(conversations)
    .where(
      and(
        eq(conversations.bookId, params.bookId),
        eq(conversations.chapterId, params.currentChapterId),
      ),
    )
    .orderBy(desc(conversations.updatedAt))
    .get();
  if (existing) {
    return { conversationId: existing.id, created: false, switchedFromActive };
  }

  const created = createConversation(db, {
    bookId: params.bookId,
    chapterId: params.currentChapterId,
  });
  return { conversationId: created.id, created: true, switchedFromActive };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/chat/conversations.test.ts`
Expected: PASS（8 测试全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/main/chat/conversations.ts src/main/chat/conversations.test.ts
git commit -m "feat(ma4): add conversation repository and selection→chapter routing"
```

---

## Task 6: ai/prompt.ts —— 分层上下文 Prompt 组装

**Files:**

- Create: `src/main/ai/prompt.ts`
- Test: `src/main/ai/prompt.test.ts`

`assemblePrompt`（设计文档 §10）产出 `ModelMessage[]`：① system（来自 Assistant）；② 历史逐条——assistant 取 text part，user 从其 `metadata.contextChips` 重建段落 / 选区上下文（不带章节摘要）；③ 当前 user 轮——带章节摘要（若 ready）+ 段落 + 选区 + 用户文本。章节摘要只随当前轮注入一次（设计判定 #3）。纯函数，仅 `import type`，无运行时 AI SDK 调用。

- [ ] **Step 1: 写失败测试**

```ts
// src/main/ai/prompt.test.ts
import { describe, expect, it } from "vitest";
import { assemblePrompt, type PromptHistoryMessage } from "@main/ai/prompt";
import type { Chip } from "@shared/chat";

function userChips(selection: string, paragraph?: string): Chip[] {
  const chips: Chip[] = [
    {
      id: "selection",
      labelKey: "chip.selection",
      content: selection,
      tokenCount: 1,
      required: true,
      enabled: true,
    },
  ];
  if (paragraph) {
    chips.push({
      id: "paragraph",
      labelKey: "chip.paragraph",
      content: paragraph,
      tokenCount: 1,
      required: true,
      enabled: true,
    });
  }
  return chips;
}

describe("assemblePrompt", () => {
  it("puts the assistant system prompt first when present", () => {
    const out = assemblePrompt({
      systemPrompt: "You are helpful.",
      chapter: null,
      history: [],
      current: { chips: userChips("sel"), userText: "explain" },
    });
    expect(out[0]).toEqual({ role: "system", content: "You are helpful." });
  });

  it("omits the system message when systemPrompt is null", () => {
    const out = assemblePrompt({
      systemPrompt: null,
      chapter: null,
      history: [],
      current: { chips: userChips("sel"), userText: "explain" },
    });
    expect(out.every((m) => m.role !== "system")).toBe(true);
  });

  it("renders the current user turn with chapter summary, context and selection", () => {
    const out = assemblePrompt({
      systemPrompt: null,
      chapter: { title: "Chapter One", summary: "It begins." },
      history: [],
      current: {
        chips: userChips("the cat", "the cat sat on the mat"),
        userText: "what does this mean?",
      },
    });
    const last = out[out.length - 1];
    expect(last.role).toBe("user");
    expect(last.content).toBe(
      "## 本章概要：Chapter One\nIt begins.\n\n" +
        "## 周围上下文\nthe cat sat on the mat\n\n" +
        "## 选中文本\nthe cat\n\n" +
        "what does this mean?",
    );
  });

  it("omits the chapter section when chapter is null and the paragraph when absent", () => {
    const out = assemblePrompt({
      systemPrompt: null,
      chapter: null,
      history: [],
      current: { chips: userChips("only selection"), userText: "hi" },
    });
    expect(out[out.length - 1].content).toBe("## 选中文本\nonly selection\n\nhi");
  });

  it("re-expands each historical user turn from its own metadata chips, without chapter summary", () => {
    const history: PromptHistoryMessage[] = [
      {
        role: "user",
        parts: [{ type: "text", text: "earlier question" }],
        metadata: {
          contextChips: [
            { id: "selection", content: "old sel", tokenCount: 1 },
            { id: "paragraph", content: "old para", tokenCount: 1 },
          ],
        },
      },
      {
        role: "assistant",
        parts: [{ type: "text", text: "earlier answer" }],
        metadata: null,
      },
    ];
    const out = assemblePrompt({
      systemPrompt: "sys",
      chapter: { title: null, summary: "current summary" },
      history,
      current: { chips: userChips("new sel"), userText: "follow up" },
    });
    expect(out[0]).toEqual({ role: "system", content: "sys" });
    expect(out[1]).toEqual({
      role: "user",
      content: "## 周围上下文\nold para\n\n## 选中文本\nold sel\n\nearlier question",
    });
    expect(out[2]).toEqual({ role: "assistant", content: "earlier answer" });
    // 章节摘要（无标题 → 仅「## 本章概要」）只出现在当前轮
    expect(out[3].content).toBe(
      "## 本章概要\ncurrent summary\n\n## 选中文本\nnew sel\n\nfollow up",
    );
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `pnpm test src/main/ai/prompt.test.ts`
Expected: FAIL —— `Cannot find module '@main/ai/prompt'`。

- [ ] **Step 3: 实现 `src/main/ai/prompt.ts`**

```ts
// src/main/ai/prompt.ts
import type { ModelMessage, UIMessage } from "ai";
import type { Chip } from "@shared/chat";
import type { MessageMetadata } from "@shared/types";

export interface PromptHistoryMessage {
  role: "system" | "user" | "assistant";
  parts: UIMessage["parts"];
  metadata: MessageMetadata | null;
}

export interface AssemblePromptParams {
  systemPrompt: string | null;
  /** 当前章摘要（仅当 ready 时传入；null = 省略）。 */
  chapter: { title: string | null; summary: string } | null;
  /** 既往消息（按 seq 升序）。 */
  history: PromptHistoryMessage[];
  current: { chips: Chip[]; userText: string };
}

function textOfParts(parts: UIMessage["parts"]): string {
  let s = "";
  for (const p of parts) if (p.type === "text") s += p.text;
  return s;
}

function chipContent(
  chips: ReadonlyArray<{ id: string; content: string }>,
  id: "selection" | "paragraph",
): string | null {
  return chips.find((c) => c.id === id)?.content ?? null;
}

function renderUserTurn(opts: {
  chapter: { title: string | null; summary: string } | null;
  paragraph: string | null;
  selection: string | null;
  userText: string;
}): string {
  const sections: string[] = [];
  if (opts.chapter) {
    const head = opts.chapter.title ? `## 本章概要：${opts.chapter.title}` : "## 本章概要";
    sections.push(`${head}\n${opts.chapter.summary}`);
  }
  if (opts.paragraph) sections.push(`## 周围上下文\n${opts.paragraph}`);
  if (opts.selection) sections.push(`## 选中文本\n${opts.selection}`);
  const context = sections.join("\n\n");
  return context ? `${context}\n\n${opts.userText}` : opts.userText;
}

/** 组装分层上下文为 ModelMessage[]（设计文档 §10）。纯函数，无模型调用。 */
export function assemblePrompt(params: AssemblePromptParams): ModelMessage[] {
  const out: ModelMessage[] = [];

  if (params.systemPrompt) out.push({ role: "system", content: params.systemPrompt });

  for (const h of params.history) {
    if (h.role === "system") continue;
    if (h.role === "assistant") {
      out.push({ role: "assistant", content: textOfParts(h.parts) });
      continue;
    }
    const chips = h.metadata?.contextChips ?? [];
    out.push({
      role: "user",
      content: renderUserTurn({
        chapter: null,
        paragraph: chipContent(chips, "paragraph"),
        selection: chipContent(chips, "selection"),
        userText: textOfParts(h.parts),
      }),
    });
  }

  out.push({
    role: "user",
    content: renderUserTurn({
      chapter: params.chapter,
      paragraph: chipContent(params.current.chips, "paragraph"),
      selection: chipContent(params.current.chips, "selection"),
      userText: params.current.userText,
    }),
  });

  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm test src/main/ai/prompt.test.ts`
Expected: PASS（5 测试全绿）。

- [ ] **Step 5: 提交**

```bash
git add src/main/ai/prompt.ts src/main/ai/prompt.test.ts
git commit -m "feat(ma4): add layered-context prompt assembly"
```

---

## Task 7: IPC 接线 —— 通道名 + chat-handlers + main 注册

**Files:**

- Modify: `src/shared/ipc.ts:4-22`（`IPC` 对象内追加 5 个通道名）
- Create: `src/main/ipc/chat-handlers.ts`
- Modify: `src/main.ts`（导入并调用 `registerChatHandlers()`）

本任务无专用单测（沿用 `settings-handlers.ts` 惯例），靠 `pnpm typecheck` + 全量 `pnpm test` 兜底。

- [ ] **Step 1: 在 `src/shared/ipc.ts` 的 `IPC` 对象内追加通道名**

把 `IPC` 对象末尾（`assistantUpdate` 之后、`} as const;` 之前）改为追加以下 5 行：

```ts
  assistantGetDefault: "assistant:get-default",
  assistantUpdate: "assistant:update",
  conversationsListByBook: "conversations:list-by-book",
  conversationsCreate: "conversations:create",
  conversationsGet: "conversations:get",
  messagesListByConversation: "messages:list-by-conversation",
  aiBuildChips: "ai:build-chips",
} as const;
```

（即保留既有的 `assistantGetDefault` / `assistantUpdate`，在其后新增 `conversationsListByBook` / `conversationsCreate` / `conversationsGet` / `messagesListByConversation` / `aiBuildChips`。）

- [ ] **Step 2: 创建 `src/main/ipc/chat-handlers.ts`**

```ts
// src/main/ipc/chat-handlers.ts
import { IPC } from "@shared/ipc";
import { bookIdInput } from "@shared/library";
import {
  buildChipsInput,
  conversationIdInput,
  createConversationInput,
  messagesByConversationInput,
  type BuildChipsInput,
  type Chip,
  type ConversationDto,
  type CreateConversationInput,
  type MessageDto,
} from "@shared/chat";
import { getDb } from "@main/db/instance";
import { buildChips } from "@main/ai/chips";
import {
  createConversation,
  getConversation,
  listConversationsByBook,
} from "@main/chat/conversations";
import { listMessages } from "@main/chat/messages";
import { handle } from "@main/ipc/registry";

export function registerChatHandlers(): void {
  handle<{ bookId: string }, ConversationDto[]>(IPC.conversationsListByBook, bookIdInput, (input) =>
    listConversationsByBook(getDb(), input.bookId),
  );

  handle<CreateConversationInput, ConversationDto>(
    IPC.conversationsCreate,
    createConversationInput,
    (input) => createConversation(getDb(), input),
  );

  handle<{ id: string }, ConversationDto | null>(
    IPC.conversationsGet,
    conversationIdInput,
    (input) => getConversation(getDb(), input.id),
  );

  handle<{ conversationId: string }, MessageDto[]>(
    IPC.messagesListByConversation,
    messagesByConversationInput,
    (input) => listMessages(getDb(), input.conversationId),
  );

  handle<BuildChipsInput, Chip[]>(IPC.aiBuildChips, buildChipsInput, (input) => buildChips(input));
}
```

- [ ] **Step 3: 在 `src/main.ts` 接线**

先确认现有调用顺序（应有 `registerLibraryHandlers()` 与 `registerSettingsHandlers()`）。在导入区追加：

```ts
import { registerChatHandlers } from "@main/ipc/chat-handlers";
```

并在 `registerSettingsHandlers();` 调用之后、`createWindow()` 之前追加：

```ts
registerSettingsHandlers();
registerChatHandlers();
```

- [ ] **Step 4: 全量校验**

Run: `pnpm typecheck`
Expected: 无错误。

Run: `pnpm test`
Expected: 既有全部测试 + 本里程碑新增测试全绿（含 `src/shared/ipc.test.ts` 仍通过——新增通道为纯追加）。

Run: `pnpm lint`
Expected: 无错误。

- [ ] **Step 5: 提交**

```bash
git add src/shared/ipc.ts src/main/ipc/chat-handlers.ts src/main.ts
git commit -m "feat(ma4): wire chat IPC handlers (conversations, messages, build-chips)"
```

> 注意：`git commit` 触发 prek（`lint:fix` + `format`）；若以「files were modified by this hook」中止，`git add` 被修改的文件后再跑一次相同 commit 即可。

---

## Self-Review

**1. Spec 覆盖（对照设计文档）：**

| 设计文档要求                                                  | 落实任务                                                     |
| ------------------------------------------------------------- | ------------------------------------------------------------ |
| §5 messages 镜像 UIMessage、parts 存纯文本、chips 入 metadata | Task 1（DTO）、Task 4（appendMessage）                       |
| §5 seq 会话内单调                                             | Task 4（`max(seq)+1` + UNIQUE 约束）                         |
| §6 会话路由四规则（追加 / 切换 / 新建 / 独立）                | Task 5（routeConversation 全分支 + 测试）                    |
| §6 段落去重「上一次插入的」                                   | Task 3（dedupeParagraph）+ Task 4（getLastParagraphContent） |
| §7/§9 chip 构建 + token 估算                                  | Task 2（estimateTokens）、Task 3（buildChips）               |
| §10 分层上下文组装、章节摘要降级、历史原样带                  | Task 6（assemblePrompt）                                     |
| §15 IPC 草图（conversations / messages / ai.buildChips）      | Task 7                                                       |

**MA5 边界（本计划不含，确认无遗漏）**：`ai.send`（routeConversation + assemblePrompt + streamText + tools + 完成落库）、工具注册表（包装 `content.ts`）、agent 多步循环、章节摘要懒生成队列（§8/§9/§11）。本计划交付的纯函数恰好是 MA5 `ai.send` 的拼装件。

**2. 占位符扫描：** 无 TBD / TODO；每个改动步骤含完整代码与可运行命令及预期输出。

**3. 类型一致性核对：**

- `Chip`（Task 1）↔ `buildChips` 返回（Task 3）↔ `assemblePrompt.current.chips`（Task 6）：字段名 `id/labelKey/content/tokenCount/required/enabled` 一致。
- `metadata.contextChips` 元素 `{id, content, tokenCount}`（既有 `messageMetadataSchema`）↔ `getLastParagraphContent`/`assemblePrompt` 读取 `c.id==="paragraph"`/`c.content`：一致。
- `ConversationDto` / `MessageDto`（Task 1）↔ 仓库 `toDto`（Task 4/5）：字段名与可空性一致。
- `RouteDecision { conversationId, created, switchedFromActive }`（Task 5）：测试与实现一致。
- IPC 泛型 `handle<I,O>` 入参类型（Task 7）↔ 各 Zod schema 推导类型（Task 1）：一致；`bookIdInput` 复用自 `@shared/library`（已存在）。

---

## 执行交接

计划已保存到 `docs/superpowers/plans/2026-05-31-marginalia-ma4-conversation-prompt.md`。两种执行方式：

1. **Subagent-Driven（推荐）** —— 每任务派发独立 subagent，任务间两阶段评审（spec 合规 + 代码质量），快速迭代。
2. **Inline Execution** —— 本会话内分批执行（executing-plans），带检查点。

选哪个？
