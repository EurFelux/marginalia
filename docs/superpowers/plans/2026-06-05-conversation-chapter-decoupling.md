# Conversation-Chapter 解耦实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 会话与章节彻底解耦（删 `chapterId` 列、删 `routeConversation`、send 必传 `conversationId`），摘要从隐式注入改为用户可控的常驻 toggle chip，标题从 userText 截断改为首轮后 AI 自动命名（含命名中闪烁）。

**Architecture:** 自外向内剥离：先做无依赖的纯收敛（tokens 挪 shared、chip 三态），再删 renderer 跨章行为，然后简化 send 链（renderer 懒建会话 + 主进程只校验），最后删 schema 列并接 auto naming 与摘要 chips。每个任务结束时 `pnpm typecheck` + `pnpm test` 必须全绿再 commit。

**Tech Stack:** Electron 41 + Drizzle 1.0-rc.3 + better-sqlite3、Zod 4、React 19（React Compiler，勿手写 useCallback/useMemo）、zustand、TanStack Query、AI SDK v6（`generateText` / `MockLanguageModelV3`）、vitest 4（跑在 Electron 运行时，`pnpm test`）。

**Spec:** `docs/superpowers/specs/2026-06-05-conversation-chapter-decoupling-design.md`

**工作分支：** 开始前 `git switch -c feat/conversation-chapter-decoupling`（当前在 main，保持本地 rebase 线性流）。

**通用注意：**

- pre-commit hook（prek）跑 `lint:fix` + `format`，可能改文件并中止提交——重新 `git add` 被改文件后**重复同一条 commit 命令**即可。
- 新增/修改 i18n 文案：代码里写 `t("key", "默认值")`，之后跑 `pnpm i18n:extract` 同步 locale 文件（Task 9 统一跑；extract 必须先于 typecheck）。
- 渲染层样式只用 Tailwind 工具类，禁止内联 `style={{}}`（运行时计算值除外）。

---

### Task 1: `estimateTokens` 挪到 `@shared/tokens`

为 Task 7（renderer 本地物化摘要 chip）铺路。纯搬移，零行为变化。

**Files:**

- Create: `src/shared/tokens.ts`
- Delete: `src/main/ai/tokens.ts`
- Modify: `src/main/ai/chips.ts:2`（import 路径）
- Rename: `src/main/ai/tokens.test.ts` → `src/shared/tokens.test.ts`（若存在；先 `ls src/main/ai/tokens.test.ts` 确认）

- [ ] **Step 1: 建分支**

```bash
git switch -c feat/conversation-chapter-decoupling
```

- [ ] **Step 2: 移动文件**

把 `src/main/ai/tokens.ts` 全文移动到 `src/shared/tokens.ts`（内容不变，首行注释路径改为 `// src/shared/tokens.ts`），删除原文件。若存在 `src/main/ai/tokens.test.ts`，同步移动到 `src/shared/tokens.test.ts` 并把其中 `@main/ai/tokens` import 改为 `@shared/tokens`。

- [ ] **Step 3: 更新引用**

```bash
grep -rn "@main/ai/tokens" src/
```

把所有命中（至少 `src/main/ai/chips.ts:2`）的 `@main/ai/tokens` 改为 `@shared/tokens`。

- [ ] **Step 4: 验证**

```bash
pnpm typecheck && pnpm test
```

Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(shared): move estimateTokens to @shared/tokens"
```

---

### Task 2: Chip 三态收敛 + id 四元

落 `src/shared/chat.ts:13` 的 MA5 TODO：`required`/`enabled` 两 bool → 三态闭合联合 `state`；chip id 枚举扩为四元。

**Files:**

- Modify: `src/shared/types.ts:7`（chipIdSchema）
- Modify: `src/shared/chat.ts:8-16`（chipSchema）
- Modify: `src/main/ai/chips.ts`（buildChips 构建值）
- Modify: `src/renderer/ai/message-history.ts`（水合 + LABEL_KEY）
- Modify: `src/renderer/ai/ChipBar.tsx:49,98`（`chip.required` → `chip.state === "required"`）
- Modify: `src/renderer/ai/chip-label.ts`（新增两 case）
- Test: `src/main/ai/chips.test.ts`、`src/renderer/ai/message-history.test.ts`

- [ ] **Step 1: 改 shared 契约**

`src/shared/types.ts:7`：

```ts
/** 上下文 chip 的 id 枚举（live Chip 与持久化 contextChips 共用，单一来源避免漂移） */
export const chipIdSchema = z.enum(["selection", "paragraph", "chapter-summary", "book-summary"]);
```

`src/shared/chat.ts:8-16` 的 chipSchema：

```ts
/** 上下文 chip（live 形态，供 renderer 渲染；持久化快照只取 {id,content,tokenCount}，见 messageMetadataSchema） */
export const chipSchema = z.object({
  id: chipIdSchema,
  labelKey: z.string(),
  content: z.string(),
  tokenCount: z.number().int().nonnegative(),
  /**
   * 三态闭合联合（spec §4）：required=必备随发不可关（选区/段落）；
   * on/off=用户 toggle（摘要 chips）。off 的 chip 发送前由 renderer 过滤。
   */
  state: z.enum(["required", "on", "off"]),
});
```

- [ ] **Step 2: 修编译错——全仓清 `.required`/`.enabled` 读取方**

```bash
pnpm typecheck
```

按报错逐个修（已知清单）：

`src/main/ai/chips.ts` buildChips 两处构建：`required: true, enabled: true` → `state: "required"`。

`src/renderer/ai/message-history.ts`：

```ts
/** 快照 id → labelKey（与主进程 buildChips / renderer 摘要 chip 物化的取值一一对应）。 */
const LABEL_KEY: Record<ChipSnapshot["id"], string> = {
  selection: "chip.selection",
  paragraph: "chip.paragraph",
  "chapter-summary": "chip.chapterSummary",
  "book-summary": "chip.bookSummary",
};

/**
 * 持久化快照 {id,content,tokenCount} → live Chip：labelKey 由 id 反推；
 * 能落库的 chip 必然实际发送过，历史不可交互，一律水合为 required。
 */
function hydrateChip(snapshot: ChipSnapshot): Chip {
  return { ...snapshot, labelKey: LABEL_KEY[snapshot.id], state: "required" };
}
```

`src/renderer/ai/ChipBar.tsx:49`：`{chip.required && ...}` → `{chip.state === "required" && ...}`；`:98` 同理。

`src/renderer/ai/chip-label.ts` switch 加两 case：

```ts
    case "chip.chapterSummary":
      return i18n.t("ai.chip.chapterSummary", "章节摘要");
    case "chip.bookSummary":
      return i18n.t("ai.chip.bookSummary", "全书摘要");
```

- [ ] **Step 3: 更新测试断言**

`src/main/ai/chips.test.ts`、`src/renderer/ai/message-history.test.ts` 中所有 `required: true` / `enabled: true` 的构造与断言改为 `state: "required"`。测试里手造 Chip 字面量的其他文件用 `grep -rn "enabled: true" src/ --include="*.test.ts*"` 找全。

- [ ] **Step 4: 验证**

```bash
pnpm typecheck && pnpm test
```

Expected: 全绿。

- [ ] **Step 5: Commit**

```bash
git add -A && git commit -m "refactor(chips): converge required/enabled bools into closed tri-state, widen chip id enum"
```

---

### Task 3: Renderer 删跨章行为

删除「跨章划词清 active」「跨章自由输入防御」两块——这是用户体验断裂的直接来源，且不依赖任何契约变更，先行摘除。

**Files:**

- Modify: `src/renderer/ai/use-ai-actions.ts:27-39`
- Modify: `src/renderer/ai/AIPanel.tsx:81-98`（handleSend）

- [ ] **Step 1: 删 use-ai-actions 跨章判别块**

`src/renderer/ai/use-ai-actions.ts` 删 27-39 行（`// 不同章划词…` 注释起到 `setActiveConversation(null);` 的 if 块止，含 `activeConversationId` 等解构与 `useNavigationStore` 的 `currentChapterId` 读取）。删除后 `useNavigationStore` import 若无其他使用一并删。

- [ ] **Step 2: 简化 AIPanel.handleSend**

`src/renderer/ai/AIPanel.tsx:81-98` 整段替换为：

```tsx
const handleSend = (text: string, chips: Chip[]) => {
  void sendMessage({ text, metadata: { contextChips: chips } });
};
```

（防御分支与注释整体删除；`useNavigationStore`/`useChatStore.getState()` 的相关读取一并清。）

- [ ] **Step 3: 验证 + Commit**

```bash
pnpm typecheck && pnpm test
git add -A && git commit -m "feat(reader): drop cross-chapter conversation splitting in renderer"
```

---

### Task 4: send 链简化——`conversationId` 必传，删隐式注入

主进程 send 从「路由 + 注入」退化为「校验 + 同构组装」；renderer 在发送前保证会话存在（懒建）。

**Files:**

- Modify: `src/shared/chat.ts`（sendInputSchema / sendAck）
- Modify: `src/shared/ipc.ts:182`（注释）
- Modify: `src/main/ai/send.ts`
- Modify: `src/main/ai/prompt.ts`
- Modify: `src/main/ipc/ai-handlers.ts`
- Modify: `src/preload-api.ts:93`（暴露 conversations.create）
- Modify: `src/renderer/ai/ipc-chat-transport.ts`
- Test: `src/main/ai/send.test.ts`、`src/main/ai/prompt.test.ts`、`src/renderer/ai/ipc-chat-transport.test.ts`、`src/main/ipc/ai-handlers.test.ts`、`src/main/ipc/bindings-coverage.test.ts`

- [ ] **Step 1: 写失败测试——send 校验会话**

`src/main/ai/send.test.ts` 新增（沿用文件内既有 `freshDb`/seed/Mock 模式）：

```ts
describe("runSend conversation validation", () => {
  it("rejects unknown conversationId without writing anything", () => {
    const db = freshDb();
    seedBook(db); // 沿用文件内已有的 seed helper 名称
    const result = runSend(makeDeps(db), {
      bookId: "book-1",
      conversationId: "nope",
      chips: [],
      userText: "hi",
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toContain("会话");
  });

  it("rejects a conversation belonging to another book", () => {
    const db = freshDb();
    seedBook(db);
    db.insert(books).values({ id: "book-2" }).run();
    const other = createConversation(db, { bookId: "book-2", chapterId: null });
    const result = runSend(makeDeps(db), {
      bookId: "book-1",
      conversationId: other.id,
      chips: [],
      userText: "hi",
    });
    expect(result.ok).toBe(false);
  });
});
```

（`makeDeps` 为该文件既有的 deps 构造 helper，名称以实际为准；`createConversation` 此时仍接 `chapterId`，Task 5 收窄后该测试调用同步改为 `{ bookId: "book-2" }`。）

- [ ] **Step 2: 跑测试确认编译失败**

```bash
pnpm test src/main/ai/send.test.ts
```

Expected: FAIL——`SendInput` 尚无 `conversationId` 字段（类型错误）。

- [ ] **Step 3: 改 shared 契约**

`src/shared/chat.ts` 的 sendInputSchema / sendAck 替换为：

```ts
/** runSend 的业务入参（不含传输层 streamId）。conversationId 必传：send 只校验不分配（spec §5）。 */
export const sendInputSchema = z.object({
  bookId: z.string().min(1),
  conversationId: z.string().min(1),
  chips: z.array(chipSchema),
  userText: z.string().min(1),
});
export type SendInput = z.infer<typeof sendInputSchema>;
```

```ts
/** ai:send invoke 的同步 ack（增量走 ai:chunk 事件流，故不含 stream/finished）。 */
export const sendAck = z.discriminatedUnion("ok", [
  z.object({ ok: z.literal(true), conversationId: z.string() }),
  z.object({ ok: z.literal(false), reason: z.string() }),
]);
```

- [ ] **Step 4: 重写 prompt.ts 为全 chip 同构渲染**

`src/main/ai/prompt.ts` 整文件替换为：

```ts
// src/main/ai/prompt.ts
import type { ModelMessage, UIMessage } from "ai";
import type { Chip, MessageDto } from "@shared/chat";

export type PromptHistoryMessage = Pick<MessageDto, "role" | "parts" | "metadata">;

export interface AssemblePromptParams {
  systemPrompt: string | null;
  /** 既往消息（按 seq 升序）。 */
  history: PromptHistoryMessage[];
  current: { chips: Chip[]; userText: string };
}

/** 仅保留 text part（assistant 的 tool-*/reasoning part 有意不回放，Phase 1 选择）。 */
export function textOfParts(parts: UIMessage["parts"]): string {
  let s = "";
  for (const p of parts) if (p.type === "text") s += p.text;
  return s;
}

type ChipLike = ReadonlyArray<{ id: string; content: string }>;

function chipContent(chips: ChipLike, id: Chip["id"]): string | null {
  return chips.find((c) => c.id === id)?.content ?? null;
}

/**
 * 单条 user 轮渲染：上下文全部来自该轮的 chips（历史轮取 metadata.contextChips 快照、
 * 当前轮取 live chips）——历史与当前完全同构，无隐藏注入通道（spec §5/§6）。
 * 固定 section 顺序：全书概要 → 本章概要 → 周围上下文 → 选中文本。
 */
function renderUserTurn(chips: ChipLike, userText: string): string {
  const sections: string[] = [];
  const bookSummary = chipContent(chips, "book-summary");
  if (bookSummary) sections.push(`## 全书概要\n${bookSummary}`);
  const chapterSummary = chipContent(chips, "chapter-summary");
  if (chapterSummary) sections.push(`## 本章概要\n${chapterSummary}`);
  const paragraph = chipContent(chips, "paragraph");
  if (paragraph) sections.push(`## 周围上下文\n${paragraph}`);
  const selection = chipContent(chips, "selection");
  if (selection) sections.push(`## 选中文本\n${selection}`);
  const context = sections.join("\n\n");
  return context ? `${context}\n\n${userText}` : userText;
}

/** 组装分层上下文为 ModelMessage[]（设计文档 §10）。纯函数，无模型调用。 */
export function assemblePrompt(params: AssemblePromptParams): ModelMessage[] {
  const out: ModelMessage[] = [];

  if (params.systemPrompt) out.push({ role: "system", content: params.systemPrompt });

  for (const h of params.history) {
    // 历史里的 system 消息丢弃：系统提示词由当前 Assistant 重新注入，避免重复/冲突
    if (h.role === "system") continue;
    if (h.role === "assistant") {
      out.push({ role: "assistant", content: textOfParts(h.parts) });
      continue;
    }
    out.push({
      role: "user",
      content: renderUserTurn(h.metadata?.contextChips ?? [], textOfParts(h.parts)),
    });
  }

  out.push({
    role: "user",
    content: renderUserTurn(params.current.chips, params.current.userText),
  });

  return out;
}
```

（`textOfParts` 改为 export——Task 6 的 naming 接线复用。）

- [ ] **Step 5: 改 send.ts——校验代替路由，删摘要注入**

`src/main/ai/send.ts`：

imports 区删除：`and`、`chapters`（保留 `eq`，新增 `conversations`）、`getChapterSummaryView`、`routeConversation`/`setConversationTitle`、`deriveConversationTitle`；`dedupeParagraph, toContextChips` 保留。删除 `getChapter` 函数（45-55 行）。

`SendResult` ok 分支删 `created`/`switchedFromActive` 两字段。

主流程 65-115 行替换为：

```ts
// 1. 先解析模型——未配置即返回错误，不落库
const resolved = resolveModel();
if (!resolved.ok) return { ok: false, reason: resolved.reason };

// 1b. 校验会话存在且属于本书（spec §5：只校验不分配，绝不默默新建）
const convo = db
  .select({ bookId: conversations.bookId })
  .from(conversations)
  .where(eq(conversations.id, input.conversationId))
  .get();
if (!convo || convo.bookId !== input.bookId) {
  return { ok: false, reason: t("errors.conversationNotFound", "会话不存在或不属于本书") };
}
const conversationId = input.conversationId;

// 2. 防御过滤 off chip（正常路径 renderer 已过滤）+ 段落去重
const activeChips = input.chips.filter((c) => c.state !== "off");
const deduped = dedupeParagraph(activeChips, getLastParagraphContent(db, conversationId));

// 3. 取历史（在落入本轮 user 消息之前）
const history = listMessages(db, conversationId);

// 4. 落 user 消息（chips 快照入 metadata）
appendMessage(db, {
  conversationId,
  role: "user",
  parts: [{ type: "text", text: input.userText }],
  metadata: { contextChips: toContextChips(deduped), model: resolved.modelId },
});

// 5. 组装 prompt（system 来自默认 Assistant；摘要不再隐式注入——随 chips 同构进入，spec §6）
const assistant = getDefaultAssistant(db);
const allMessages: ModelMessage[] = assemblePrompt({
  systemPrompt: assistant.systemPrompt,
  history,
  current: { chips: deduped, userText: input.userText },
});
```

返回值（207-215 行）改为：

```ts
return {
  ok: true,
  conversationId,
  stream: callerStream,
  finished,
};
```

- [ ] **Step 6: 改 ai-handlers ack**

`src/main/ipc/ai-handlers.ts:50-55`：

```ts
return { ok: true, conversationId: result.conversationId };
```

- [ ] **Step 7: preload 暴露 conversations.create**

`src/preload-api.ts:93-95` chat.conversations 块加一行：

```ts
      conversations: {
        listByBook: inv(C.conversationsListByBook),
        create: inv(C.conversationsCreate),
      },
```

`src/shared/ipc.ts:182` 注释改为：`// chat（conversationsGet 为 main-only：有 handler、preload 不暴露）`。
若 `src/main/ipc/bindings-coverage.test.ts` 维护 main-only 白名单，把 `conversationsCreate` 移出该名单。

- [ ] **Step 8: 改 transport——发送前懒建会话**

`src/renderer/ai/ipc-chat-transport.ts` 的 `sendMessages` 替换为：

```ts
    async sendMessages({ messages, abortSignal }) {
      const { currentBookId } = useNavigationStore.getState();
      if (!currentBookId) {
        const { default: i18n } = await import("@renderer/i18n");
        throw new Error(i18n.t("ai.noBookToSend", "没有正在阅读的书，无法发送。"));
      }
      // 发送前保证目标会话存在（spec §7）：无 active → 懒建（主进程防堆积兜底）
      let conversationId = useChatStore.getState().activeConversationId;
      if (!conversationId) {
        const convo = await window.api.chat.conversations.create({
          bookId: currentBookId,
          chapterId: null, // Task 5 收窄 createConversationInput 后删本字段
        });
        useChatStore.getState().setActiveConversation(convo.id);
        conversationId = convo.id;
      }
      const last = messages.at(-1);
      const userText = lastUserText(messages);
      // off 的 chip 不发送（spec §6）；快照本身无 state（历史水合为 required），仅 live chips 有
      const chips = (last?.metadata?.contextChips ?? []).filter((c) => c.state !== "off");

      const streamId = uuidv7();
      const stream = createEventStream(streamId, window.api.ai.onChunk);
      abortSignal?.addEventListener("abort", () => void window.api.ai.abort({ streamId }));

      const ack = await window.api.ai.send({
        streamId,
        bookId: currentBookId,
        conversationId,
        chips,
        userText,
      });
      if (!ack.ok) {
        void stream.cancel(); // 触发 cancel() → 退订，避免监听器泄漏
        throw new Error(ack.reason); // useChat 进 error 态
      }
      return stream;
    },
```

注意：`setActiveConversation` 此时仍是双参签名（Task 5 收窄），单参调用兼容（第二参可选）。文件头注释中「activeConversationId 为稳定态」等描述同步改写。
关于 metadata 类型：`ChatUIMessage.metadata.contextChips` 是 live `Chip[]`（含 state），`filter` 后直接可传 `sendInputSchema.chips`。

- [ ] **Step 9: 改 transport 调用方 AIPanel 的 ack 依赖**

`grep -n "setActiveConversation" src/renderer/ai/` 确认 transport 内 ack 回写已删（Step 8 已做），AIPanel 无 ack 依赖即可。

- [ ] **Step 10: 更新既有测试**

- `src/main/ai/send.test.ts`：所有 `runSend` 调用从 `{ bookId, currentChapterId, activeConversationId, ... }` 改为 `{ bookId, conversationId, ... }`——既有用例需先显式 `createConversation` 再传其 id；断言 `result.created` / `switchedFromActive` 的语句删除；「章节摘要注入」相关用例删除（prompt.test.ts 接管摘要渲染断言）。
- `src/main/ai/prompt.test.ts`：删 `chapter` 参数与「摘要仅注入当前轮”用例；新增——当前轮 chips 含 `{ id: "chapter-summary", content: "本章讲了 X", ... }` 时输出含 `## 本章概要\n本章讲了 X`；含 `book-summary` 时输出含 `## 全书概要`；历史轮快照含摘要 chip 时该历史 user 轮同样渲染（同构断言）。
- `src/renderer/ai/ipc-chat-transport.test.ts`：fake `window.api` 需补 `chat.conversations.create`；断言 send 载荷含 `conversationId` 而非 `currentChapterId`/`activeConversationId`。
- `src/main/ipc/ai-handlers.test.ts`：ack 形状断言更新。

- [ ] **Step 11: 验证**

```bash
pnpm test src/main/ai/send.test.ts src/main/ai/prompt.test.ts
pnpm typecheck && pnpm test
```

Expected: 全绿（Step 1 的失败测试现在通过）。

- [ ] **Step 12: Commit**

```bash
git add -A && git commit -m "feat(ai): send requires explicit conversationId; summaries ride chips, not hidden injection"
```

---

### Task 5: Schema 删列 + DTO 平铺 + create 防堆积

**Files:**

- Modify: `src/main/db/schema.ts:116-134`（conversations 表）
- Create: `src/main/db/migrations/<timestamp>_*/`（`pnpm db:generate` 生成）
- Modify: `src/shared/chat.ts`（ConversationDto / createConversationInput）
- Modify: `src/main/chat/conversations.ts`（toDto / createConversation / 删 route）
- Modify: `src/renderer/store/chat-store.ts`（删 activeConversationChapterId）
- Modify: `src/renderer/reader/ConversationsTab.tsx`（单行 item）
- Modify: `src/renderer/ai/AIPanel.tsx`（header 第二行）
- Modify: `src/renderer/ai/ipc-chat-transport.ts`（create 入参收窄）
- Delete: `src/renderer/query/use-chapter-title.ts`（若 AIPanel 是唯一消费者，用 grep 确认）
- Test: `src/main/chat/conversations.test.ts`、`src/renderer/store/chat-store.test.ts`

- [ ] **Step 1: 写失败测试——防堆积复用空会话**

`src/main/chat/conversations.test.ts` 新增（其余既有用例的修复在 Step 5）：

```ts
describe("createConversation reuses empty conversation", () => {
  it("returns the existing zero-message conversation instead of stacking new ones", () => {
    const db = freshDb();
    seedBookWithChapters(db);
    const first = createConversation(db, { bookId: "book-1" });
    const second = createConversation(db, { bookId: "book-1" });
    expect(second.id).toBe(first.id);
  });

  it("creates a fresh conversation when the existing one has messages", () => {
    const db = freshDb();
    seedBookWithChapters(db);
    const first = createConversation(db, { bookId: "book-1" });
    appendMessage(db, {
      conversationId: first.id,
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
    const second = createConversation(db, { bookId: "book-1" });
    expect(second.id).not.toBe(first.id);
  });
});
```

（顶部补 `import { appendMessage } from "@main/chat/messages";`。）

- [ ] **Step 2: 删 schema 列 + 生成迁移**

`src/main/db/schema.ts` conversations 表删除 `chapterId` 整段定义（`chapterId: text("chapter_id").references(...)` 三行）。然后：

```bash
pnpm db:generate
```

检查生成的迁移目录（`src/main/db/migrations/<timestamp>_*/migration.sql`）：应为表重建（CREATE 新表无 `chapter_id` → INSERT SELECT → DROP 旧表 → RENAME）。**不要手工编辑迁移文件**。

- [ ] **Step 3: 改 shared 契约**

`src/shared/chat.ts`：

```ts
/** conversations:create 入参。 */
export const createConversationInput = z.object({
  bookId: z.string().min(1),
});
export type CreateConversationInput = z.infer<typeof createConversationInput>;
```

`ConversationBase` + 判别联合（43-60 行）整体替换为：

```ts
/** 会话视图。bookId/assistantId 恒非空（列已 NOT NULL）；isNaming 为主进程内存瞬态合成（spec §5）。 */
export interface ConversationDto {
  id: string;
  bookId: string;
  assistantId: string;
  title: string | null;
  /** auto naming 进行中（Task 6 接线前恒 false）。 */
  isNaming: boolean;
  createdAt: number;
  updatedAt: number;
}
```

- [ ] **Step 4: 改 conversations.ts**

`src/main/chat/conversations.ts` 整文件替换为（route 删除）：

```ts
// src/main/chat/conversations.ts
import { and, desc, eq, isNull } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { conversations, messages } from "@main/db/schema";
import { getDefaultAssistant } from "@main/providers/assistant";
import { isNamingConversation } from "@main/chat/conversation-title";
import type { ConversationDto, CreateConversationInput } from "@shared/chat";

type ConversationRow = typeof conversations.$inferSelect;

function toDto(row: ConversationRow): ConversationDto {
  return {
    id: row.id,
    bookId: row.bookId,
    assistantId: row.assistantId,
    title: row.title ?? null,
    isNaming: isNamingConversation(row.id),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/**
 * 创建会话；assistantId 取默认 Assistant（按需惰性播种）。
 * 防堆积（spec §5）：该书已存在零消息会话 → 返回最新的那个而不新建。
 */
export function createConversation(db: DB, input: CreateConversationInput): ConversationDto {
  const empty = db
    .select({ row: conversations })
    .from(conversations)
    .leftJoin(messages, eq(messages.conversationId, conversations.id))
    .where(and(eq(conversations.bookId, input.bookId), isNull(messages.id)))
    .orderBy(desc(conversations.updatedAt))
    .limit(1)
    .get();
  if (empty) return toDto(empty.row);

  const assistant = getDefaultAssistant(db);
  const row = db
    .insert(conversations)
    .values({ bookId: input.bookId, assistantId: assistant.id })
    .returning()
    .get();
  return toDto(row);
}

export function getConversation(db: DB, id: string): ConversationDto | null {
  const row = db.select().from(conversations).where(eq(conversations.id, id)).get();
  return row ? toDto(row) : null;
}

/** 设置会话标题（auto naming 写回；未来手动命名复用）。 */
export function setConversationTitle(db: DB, id: string, title: string): void {
  db.update(conversations).set({ title }).where(eq(conversations.id, id)).run();
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
```

**过渡桩**：`isNamingConversation` 在 Task 6 才实现。本任务先在 `src/main/chat/conversation-title.ts` **追加**（旧 derive 暂保留到 Task 6 删）：

```ts
/** auto naming 进行中查询（Task 6 实现真状态；先恒 false 占位接通编译）。 */
const namingInFlight = new Set<string>();
export function isNamingConversation(id: string): boolean {
  return namingInFlight.has(id);
}
```

- [ ] **Step 5: 修全仓编译错**

```bash
pnpm typecheck
```

已知清单：

a) `src/main/ai/send.test.ts`（Task 4 Step 1 注释预告）：`createConversation(db, { bookId: "book-2", chapterId: null })` → `{ bookId: "book-2" }`，其余同类调用同改。

b) `src/renderer/store/chat-store.ts` 整文件替换：

```ts
import { create } from "zustand";
import type { Chip } from "@shared/chat";
import { usePrefsStore } from "@renderer/store/prefs-store";

interface ChatState {
  activeConversationId: string | null;
  draftText: string;
  draftChips: Chip[];
  /**
   * 一次性命令信号（非状态）：nonce 递增触发 AIPanel 载入该会话历史。
   * 与 activeConversationId 解耦——发消息路径只设 activeConversationId、不发本命令，
   * 故发消息不会触发历史重载（避免覆盖刚流式出来的内容）。镜像 annotation-store.scrollCommand。
   */
  openCommand: { conversationId: string; nonce: number } | null;
}
interface ChatActions {
  setActiveConversation: (id: string | null) => void;
  setDraftText: (text: string) => void;
  setDraftChips: (chips: Chip[]) => void;
  /** 重开会话：发命令信号（触发载历史）+ 设 active（高亮）+ 开面板（经 prefs-store 布局）。 */
  openConversation: (id: string) => void;
  /** 开书恢复最近会话：同 openConversation 但不强制开面板（spec §7）。 */
  restoreConversation: (id: string) => void;
}

export const CHAT_INITIAL: ChatState = {
  activeConversationId: null,
  draftText: "",
  draftChips: [],
  openCommand: null,
};

export const useChatStore = create<ChatState & ChatActions>((set) => ({
  ...CHAT_INITIAL,
  setActiveConversation: (id) => set({ activeConversationId: id }),
  setDraftText: (draftText) => set({ draftText }),
  setDraftChips: (draftChips) => set({ draftChips }),
  openConversation: (id) => {
    usePrefsStore.getState().updateLayout({ panelOpen: true });
    return set((s) => ({
      activeConversationId: id,
      openCommand: { conversationId: id, nonce: (s.openCommand?.nonce ?? 0) + 1 },
    }));
  },
  restoreConversation: (id) =>
    set((s) => ({
      activeConversationId: id,
      openCommand: { conversationId: id, nonce: (s.openCommand?.nonce ?? 0) + 1 },
    })),
}));
```

c) `src/renderer/reader/ConversationsTab.tsx`：删 `chapters` query、`chapterLabel`、`ChapterRefDto` import；`primaryLabel` 与 item 改为：

```tsx
const primaryLabel = (c: ConversationDto): string =>
  c.title?.trim() ? c.title : t("reader.conversation.untitled", "未命名会话");
```

item 按钮内（单行：图标 + 标题 + 时间）：

```tsx
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
  <span className="min-w-0 flex-1 truncate text-xs text-foreground">{primaryLabel(c)}</span>
  <span className="shrink-0 text-[10px] text-muted-foreground/70">
    {relativeTime(c.updatedAt, now, i18n.language)}
  </span>
</button>
```

d) `src/renderer/ai/AIPanel.tsx`：

- 删 `activeConversationChapterId` 读取（30 行）、`useChapterTitle`（32-34 行）与其 import、`useNavigationStore` 的 `currentChapterId` 读取（若无他用删 import）。
- header 第二行改为活跃会话标题（spec §7）：

```tsx
const bookId = useNavigationStore((s) => s.currentBookId);
const conversations = useQuery({
  queryKey: qk.conversations(bookId ?? ""),
  queryFn: () => window.api.chat.conversations.listByBook({ bookId: bookId! }),
  enabled: bookId != null,
});
const activeTitle = activeConversationId
  ? conversations.data?.find((c) => c.id === activeConversationId)?.title?.trim() ||
    t("reader.conversation.untitled", "未命名会话")
  : null;
```

JSX 中 `{chapterTitle && (...)}` 块替换为：

```tsx
{
  activeTitle && <span className="truncate text-[11px] text-muted-foreground">{activeTitle}</span>;
}
```

（`qk` / `useQuery` import 补上；`ai.conversationSuffix` key 不再使用，留待 Task 9 extract 清理。）

e) `src/renderer/ai/ipc-chat-transport.ts`：create 调用收窄为 `{ bookId: currentBookId }`（删 Task 4 的 `chapterId: null` 临时行）。

f) `src/renderer/store/chat-store.test.ts`：`openConversation("id", null)` 之类双参调用改单参；`activeConversationChapterId` 断言删除；新增 `restoreConversation` 用例（设 active + 递增 openCommand.nonce，不碰 prefs 布局——断言镜像既有 openConversation 用例改写）。

g) `src/main/chat/conversations.test.ts`：删 `routeConversation` import 与整个 route describe 块；既有断言 `convo.kind` / `convo.chapterId` 删除；`createConversation(db, { bookId: "book-1", chapterId: ch1 })` 全部改 `{ bookId: "book-1" }`（`seedBookWithChapters` 返回的 ch id 不再传给会话，但 seed 本身保留——messages 等仍需要 book）。注意：原「lists conversations」用例靠两次 create 造两个会话——防堆积会让第二次复用！改为第一次 create 后先 `appendMessage` 再 create 第二个。

- [ ] **Step 6: 验证迁移与全量**

```bash
pnpm test src/main/chat/conversations.test.ts
pnpm typecheck && pnpm test
```

Expected: 全绿（`:memory:` 库每次跑 runMigrations，已覆盖新迁移链）。

- [ ] **Step 7: Commit**

```bash
git add -A && git commit -m "feat(chat)!: drop conversations.chapter_id — conversations decoupled from chapters"
```

---

### Task 6: Auto naming——首轮完成后 AI 起名

**Files:**

- Rewrite: `src/main/chat/conversation-title.ts`
- Modify: `src/main/ai/send.ts`（onFinish 接线）
- Test: Create `src/main/chat/conversation-title.test.ts`（替换旧 derive 测试；若存在旧文件先看其结构）、`src/main/ai/send.test.ts` 补接线用例

- [ ] **Step 1: 写失败测试**

`src/main/chat/conversation-title.test.ts`（新建或重写）：

```ts
// src/main/chat/conversation-title.test.ts
import path from "node:path";
import { describe, expect, it, beforeEach } from "vitest";
import { MockLanguageModelV3 } from "ai/test";
import { createDb, runMigrations } from "@main/db/client";
import { books } from "@main/db/schema";
import {
  createConversation,
  getConversation,
  setConversationTitle,
} from "@main/chat/conversations";
import {
  isNamingConversation,
  nameConversation,
  sanitizeTitle,
  __resetNamingRuntime,
} from "@main/chat/conversation-title";

const MIGRATIONS = path.resolve(__dirname, "../db/migrations");

function freshDb() {
  const db = createDb(":memory:");
  runMigrations(db, MIGRATIONS);
  db.insert(books).values({ id: "book-1" }).run();
  return db;
}

/** doGenerate 直返固定标题的 mock（generateText 走 doGenerate；参数形状如有出入参照 send.test.ts 的 MockLanguageModelV3 用法微调）。 */
function namingModel(title: string) {
  return new MockLanguageModelV3({
    doGenerate: async () => ({
      finishReason: "stop" as const,
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      content: [{ type: "text" as const, text: title }],
      warnings: [],
    }),
  });
}

beforeEach(() => __resetNamingRuntime());

describe("sanitizeTitle", () => {
  it("strips quotes/whitespace and truncates to 40 chars with ellipsis", () => {
    expect(sanitizeTitle("「象征意义」")).toBe("象征意义");
    expect(sanitizeTitle(`"  A title  "`)).toBe("A title");
    expect(sanitizeTitle("好".repeat(50))).toBe("好".repeat(40) + "…");
    expect(sanitizeTitle("  \n ")).toBe("");
  });
});

describe("nameConversation", () => {
  it("writes a sanitized title and clears isNaming after settle", async () => {
    const db = freshDb();
    const convo = createConversation(db, { bookId: "book-1" });
    await nameConversation(
      { db, resolveModel: () => ({ ok: true, model: namingModel("雾的象征"), modelId: "m" }) },
      convo.id,
      "这段雾的描写是什么意思",
      "雾在这里象征……",
    );
    expect(getConversation(db, convo.id)?.title).toBe("雾的象征");
    expect(isNamingConversation(convo.id)).toBe(false);
  });

  it("keeps title null and stays silent when the model is not configured", async () => {
    const db = freshDb();
    const convo = createConversation(db, { bookId: "book-1" });
    await nameConversation(
      { db, resolveModel: () => ({ ok: false, reason: "no model" }) },
      convo.id,
      "u",
      "a",
    );
    expect(getConversation(db, convo.id)?.title).toBeNull();
  });

  it("does not overwrite an already-set title", async () => {
    const db = freshDb();
    const convo = createConversation(db, { bookId: "book-1" });
    setConversationTitle(db, convo.id, "手动名");
    await nameConversation(
      { db, resolveModel: () => ({ ok: true, model: namingModel("AI 名"), modelId: "m" }) },
      convo.id,
      "u",
      "a",
    );
    expect(getConversation(db, convo.id)?.title).toBe("手动名");
  });
});
```

（`resolveModel` 返回值形状以 `src/main/ai/assistant-model.ts` 的 `ResolvedModel` 为准——ok 分支若含其他必填字段按需补。）

- [ ] **Step 2: 跑红**

```bash
pnpm test src/main/chat/conversation-title.test.ts
```

Expected: FAIL——`nameConversation`/`sanitizeTitle` 未导出。

- [ ] **Step 3: 重写 conversation-title.ts**

```ts
// src/main/chat/conversation-title.ts
import { generateText } from "ai";
import { eq } from "drizzle-orm";
import type { DB } from "@main/db/client";
import { conversations } from "@main/db/schema";
import type { ResolvedModel } from "@main/ai/assistant-model";

const MAX_TITLE_LEN = 40;

const NAMING_SYSTEM =
  "你是会话命名助手。根据给出的一轮对话，产出一个能概括话题的简短标题。" +
  "要求：使用与对话内容相同的语言；不超过 15 个字/词；只输出标题本身，不要引号、句号或任何解释。";

export interface NamingDeps {
  db: DB;
  resolveModel: () => ResolvedModel;
}

// 命名中状态：进程内存瞬态（spec §5）——settle 即清除、不落库；重启自然归零，
// 失败遗留的 null title 不会被误标为命名中。
const namingInFlight = new Set<string>();

export function isNamingConversation(id: string): boolean {
  return namingInFlight.has(id);
}

/** 仅供测试：清空命名运行时态。 */
export function __resetNamingRuntime(): void {
  namingInFlight.clear();
}

/** 清洗模型产出：取首个非空行、剥首尾引号、压缩空白、截断到 MAX_TITLE_LEN（超出加省略号）。 */
export function sanitizeTitle(raw: string): string {
  const firstLine =
    raw
      .split("\n")
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const unquoted = firstLine.replace(/^["'“”‘’「」『』]+|["'“”‘’「」『』]+$/g, "");
  const collapsed = unquoted.replace(/\s+/g, " ").trim();
  return [...collapsed].length <= MAX_TITLE_LEN // oxlint-disable-line no-misused-spread
    ? collapsed
    : [...collapsed].slice(0, MAX_TITLE_LEN).join("") + "…"; // oxlint-disable-line no-misused-spread
}

/**
 * 首轮完成后的会话自动命名（spec §5）：用触发轮的 user+assistant 做一次非流式短调用。
 * fire-and-forget：失败/未配置模型 → title 保持 null（UI 走 i18n 占位）、仅落日志——绝不编造标题。
 */
export async function nameConversation(
  deps: NamingDeps,
  conversationId: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  if (namingInFlight.has(conversationId)) return;
  const resolved = deps.resolveModel();
  if (!resolved.ok) {
    console.warn("[naming] model not configured; keep title null:", resolved.reason);
    return;
  }
  namingInFlight.add(conversationId);
  try {
    const { text } = await generateText({
      model: resolved.model,
      system: NAMING_SYSTEM,
      prompt: `用户：${userText}\n\n助手：${assistantText}`,
    });
    const title = sanitizeTitle(text);
    if (!title) return;
    // 写回前复查 title 仍为 null——不覆盖期间已被设置的标题
    const row = deps.db
      .select({ title: conversations.title })
      .from(conversations)
      .where(eq(conversations.id, conversationId))
      .get();
    if (row && row.title == null) {
      deps.db
        .update(conversations)
        .set({ title })
        .where(eq(conversations.id, conversationId))
        .run();
    }
  } catch (err) {
    console.warn("[naming] failed; keep title null:", err);
  } finally {
    namingInFlight.delete(conversationId);
  }
}
```

（旧 `deriveConversationTitle` 与 Task 5 的占位桩删除；旧 derive 测试文件若存在则删。）

- [ ] **Step 4: 跑绿**

```bash
pnpm test src/main/chat/conversation-title.test.ts
```

Expected: PASS。

- [ ] **Step 5: send.ts 接线**

`src/main/ai/send.ts`：

- imports 补：`import { nameConversation } from "@main/chat/conversation-title";`、`import { textOfParts } from "@main/ai/prompt";`、`conversations`（Task 4 已引入）。
- `uiStream` 的 `onFinish` 回调里 `appendMessage(...)` 之后追加：

```ts
// 首轮完成 → 自动命名（spec §5）：title 仍 null 且本轮 complete 才触发；fire-and-forget
if (status === "complete") {
  const row = db
    .select({ title: conversations.title })
    .from(conversations)
    .where(eq(conversations.id, conversationId))
    .get();
  if (row && row.title == null) {
    void nameConversation(
      { db, resolveModel },
      conversationId,
      input.userText,
      textOfParts(responseMessage.parts),
    );
  }
}
```

- [ ] **Step 6: send 接线测试**

`src/main/ai/send.test.ts` 新增用例（沿用文件内 happy-path mock 流模式）。关键点：naming 与流式共用 `deps.resolveModel`，故给既有 happy-path 的 `MockLanguageModelV3` 在 `doStream` 旁**补一个 `doGenerate`**（返回形状照抄 Task 6 Step 1 的 `namingModel`，text 固定如 `"AI 标题"`）：

```ts
it("auto-names the conversation after the first completed turn", async () => {
  const db = freshDb();
  seedBook(db);
  const convo = createConversation(db, { bookId: "book-1" });
  const result = runSend(makeDeps(db), {
    bookId: "book-1",
    conversationId: convo.id,
    chips: [],
    userText: "这段是什么意思",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  await result.finished;
  // naming 为 fire-and-forget，落库晚于 finished → 轮询等待
  await vi.waitFor(() => expect(getConversation(db, convo.id)?.title).toBe("AI 标题"));
});

it("does not rename a conversation that already has a title", async () => {
  const db = freshDb();
  seedBook(db);
  const convo = createConversation(db, { bookId: "book-1" });
  setConversationTitle(db, convo.id, "既有名");
  const result = runSend(makeDeps(db), {
    bookId: "book-1",
    conversationId: convo.id,
    chips: [],
    userText: "hi",
  });
  expect(result.ok).toBe(true);
  if (!result.ok) return;
  await result.finished;
  await new Promise((r) => setTimeout(r, 50)); // 给误触发留窗口
  expect(getConversation(db, convo.id)?.title).toBe("既有名");
});
```

（`vi` 从 vitest import；`seedBook`/`makeDeps` 用该文件实际 helper 名；`getConversation`/`setConversationTitle`/`createConversation` 按需补 import。）

- [ ] **Step 7: 全量验证 + Commit**

```bash
pnpm typecheck && pnpm test
git add -A && git commit -m "feat(chat): auto-name conversation after first completed turn"
```

---

### Task 7: 摘要 chip 化——常驻 toggle + 物化发送

**Files:**

- Modify: `src/renderer/store/chat-store.ts`（summaryChips 状态机）
- Create: `src/renderer/ai/SummaryChipToggles.tsx`
- Modify: `src/renderer/ai/Composer.tsx`（渲染 toggles + 发送物化）
- Test: `src/renderer/store/chat-store.test.ts`、Create `src/renderer/ai/summary-chips.test.ts`

- [ ] **Step 1: 写失败测试——store 状态机**

`src/renderer/store/chat-store.test.ts` 新增：

```ts
describe("summaryChips state machine", () => {
  it("defaults to off, presets both on, resets to off", () => {
    const s = useChatStore.getState();
    expect(s.summaryChips).toEqual({ chapter: false, book: false });
    s.setSummaryChipsPreset();
    expect(useChatStore.getState().summaryChips).toEqual({ chapter: true, book: true });
    useChatStore.getState().resetSummaryChips();
    expect(useChatStore.getState().summaryChips).toEqual({ chapter: false, book: false });
  });

  it("toggles a single kind", () => {
    useChatStore.getState().setSummaryChip("chapter", true);
    expect(useChatStore.getState().summaryChips.chapter).toBe(true);
    expect(useChatStore.getState().summaryChips.book).toBe(false);
  });
});
```

（该测试文件若有 store 重置 helper / beforeEach，沿用其模式重置 summaryChips。）

- [ ] **Step 2: 跑红，然后实现 store**

`src/renderer/store/chat-store.ts`：`ChatState` 加 `summaryChips: { chapter: boolean; book: boolean };`、`CHAT_INITIAL` 加 `summaryChips: { chapter: false, book: false },`、`ChatActions` 与实现加：

```ts
  setSummaryChip: (kind: "chapter" | "book", on: boolean) =>
    set((s) => ({ summaryChips: { ...s.summaryChips, [kind]: on } })),
  /** 「将开启新会话」预亮（spec §6）：新对话按钮 / 开书无会话。 */
  setSummaryChipsPreset: () => set({ summaryChips: { chapter: true, book: true } }),
  /** 发送后回落 off（一段对话只输入一次摘要）。 */
  resetSummaryChips: () => set({ summaryChips: { chapter: false, book: false } }),
```

跑绿：`pnpm test src/renderer/store/chat-store.test.ts`。

- [ ] **Step 3: 写摘要 chip 物化纯函数 + 测试**

Create `src/renderer/ai/summary-chips.ts`：

```ts
// src/renderer/ai/summary-chips.ts
import type { Chip } from "@shared/chat";
import type { SummaryStatus } from "@shared/library";
import { estimateTokens } from "@shared/tokens";

export interface SummaryView {
  status: SummaryStatus;
  summary: string | null;
}

/**
 * 把 enabled 的摘要 toggle 物化为随消息发送的 live Chip（spec §6）：
 * 仅 ready 且有正文的摘要物化；未 ready 的跳过（不阻塞发送，toggle 保持 on 等下一条）。
 * content 为发送时快照——之后重新生成摘要不影响已发送消息。
 */
export function materializeSummaryChips(
  enabled: { chapter: boolean; book: boolean },
  chapter: SummaryView | undefined,
  book: SummaryView | undefined,
): Chip[] {
  const chips: Chip[] = [];
  if (enabled.book && book?.status === "ready" && book.summary) {
    chips.push({
      id: "book-summary",
      labelKey: "chip.bookSummary",
      content: book.summary,
      tokenCount: estimateTokens(book.summary),
      state: "on",
    });
  }
  if (enabled.chapter && chapter?.status === "ready" && chapter.summary) {
    chips.push({
      id: "chapter-summary",
      labelKey: "chip.chapterSummary",
      content: chapter.summary,
      tokenCount: estimateTokens(chapter.summary),
      state: "on",
    });
  }
  return chips;
}
```

Create `src/renderer/ai/summary-chips.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { materializeSummaryChips } from "@renderer/ai/summary-chips";

describe("materializeSummaryChips", () => {
  it("materializes only enabled+ready summaries", () => {
    const chips = materializeSummaryChips(
      { chapter: true, book: true },
      { status: "ready", summary: "章摘" },
      { status: "generating", summary: null },
    );
    expect(chips.map((c) => c.id)).toEqual(["chapter-summary"]);
    expect(chips[0].content).toBe("章摘");
    expect(chips[0].state).toBe("on");
  });

  it("returns empty when toggles are off even if summaries are ready", () => {
    const chips = materializeSummaryChips(
      { chapter: false, book: false },
      { status: "ready", summary: "x" },
      { status: "ready", summary: "y" },
    );
    expect(chips).toEqual([]);
  });
});
```

跑绿：`pnpm test src/renderer/ai/summary-chips.test.ts`。

- [ ] **Step 4: SummaryChipToggles 组件**

Create `src/renderer/ai/SummaryChipToggles.tsx`：

```tsx
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { BookOpen, FileText, Loader2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import type { SummaryStatus } from "@shared/library";
import { cn } from "@renderer/lib/utils";
import { useChatStore } from "@renderer/store/chat-store";
import { useNavigationStore } from "@renderer/store/navigation-store";
import { chapterSummaryQuery, bookSummaryQuery } from "@renderer/query/summary-queries";
import { qk } from "@renderer/query/keys";

/**
 * 常驻摘要 toggle chips（spec §6）：off 灰 / on 亮 / 生成中 spinner。
 * 手动点 on 且未生成 → 触发生成（显式意图）；自动预设 on 不触发生成。
 */
export function SummaryChipToggles() {
  const { t } = useTranslation();
  const qc = useQueryClient();
  const bookId = useNavigationStore((s) => s.currentBookId);
  const chapterId = useNavigationStore((s) => s.currentChapterId);
  const summaryChips = useChatStore((s) => s.summaryChips);
  const setSummaryChip = useChatStore((s) => s.setSummaryChip);

  const chapter = useQuery({
    ...chapterSummaryQuery(bookId ?? "", chapterId ?? ""),
    enabled: bookId != null && chapterId != null,
  });
  const book = useQuery({ ...bookSummaryQuery(bookId ?? ""), enabled: bookId != null });

  if (!bookId) return null;

  const toggle = (kind: "chapter" | "book", status: SummaryStatus | undefined, on: boolean) => {
    if (!on && (status === "pending" || status === "unavailable")) {
      // off→on 且未生成/上次失败：触发生成（fire-and-forget；预检失败经 registry 落日志）
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

  const pill = (
    kind: "chapter" | "book",
    label: string,
    status: SummaryStatus | undefined,
    on: boolean,
    Icon: typeof FileText,
  ) => (
    <button
      type="button"
      onClick={() => toggle(kind, status, on)}
      aria-pressed={on}
      className={cn(
        "flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] transition-colors",
        on
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border bg-muted/40 text-muted-foreground hover:bg-muted",
      )}
    >
      {status === "generating" ? (
        <Loader2 className="size-3 animate-spin" />
      ) : (
        <Icon className="size-3" />
      )}
      {label}
    </button>
  );

  return (
    <div className="mb-2 flex gap-1.5">
      {chapterId &&
        pill(
          "chapter",
          t("ai.chip.chapterSummary", "章节摘要"),
          chapter.data?.status,
          summaryChips.chapter,
          FileText,
        )}
      {pill(
        "book",
        t("ai.chip.bookSummary", "全书摘要"),
        book.data?.status,
        summaryChips.book,
        BookOpen,
      )}
    </div>
  );
}
```

- [ ] **Step 5: Composer 接入——渲染 + 发送物化 + 回落**

`src/renderer/ai/Composer.tsx`：

- imports 补：`SummaryChipToggles`、`materializeSummaryChips`、`useQuery`、`chapterSummaryQuery`/`bookSummaryQuery`、`useNavigationStore`。
- 组件内补 query（与 Toggles 同 key 共享缓存）：

```tsx
const bookId = useNavigationStore((s) => s.currentBookId);
const chapterId = useNavigationStore((s) => s.currentChapterId);
const summaryChips = useChatStore((s) => s.summaryChips);
const resetSummaryChips = useChatStore((s) => s.resetSummaryChips);
const chapterSummary = useQuery({
  ...chapterSummaryQuery(bookId ?? "", chapterId ?? ""),
  enabled: bookId != null && chapterId != null,
});
const bookSummary = useQuery({ ...bookSummaryQuery(bookId ?? ""), enabled: bookId != null });
```

- `send()` 改为（spec §6：发送后已物化的回落 off，未 ready 被跳过的**保持 on**——生成完成后随下一条消息带上）：

```tsx
const send = () => {
  const text = draftText.trim();
  if (!text || isStreaming) return;
  const summaryExtras = materializeSummaryChips(
    summaryChips,
    chapterSummary.data,
    bookSummary.data,
  );
  onSend(text, [...summaryExtras, ...draftChips]);
  setDraftText("");
  setDraftChips([]);
  // 已随本条发送的摘要回落 off（一段对话只输入一次）；未 ready 被 materialize 跳过的保持 on
  const sent = new Set(summaryExtras.map((c) => c.id));
  const { setSummaryChip } = useChatStore.getState();
  if (sent.has("chapter-summary")) setSummaryChip("chapter", false);
  if (sent.has("book-summary")) setSummaryChip("book", false);
};
```

（本组件不需要 `resetSummaryChips`——Step 1 测试覆盖的 store action 本身保留，消费方在 Task 8 之外暂无。）

- JSX：`{draftChips.length > 0 && ...ChipBar...}` 块上方加 `<SummaryChipToggles />`：

```tsx
<SummaryChipToggles />;
{
  draftChips.length > 0 && (
    <div className="mb-2">
      <ChipBar chips={draftChips} />
    </div>
  );
}
```

- [ ] **Step 6: 验证 + Commit**

```bash
pnpm typecheck && pnpm test
git add -A && git commit -m "feat(ai): summary context as user-controlled persistent toggle chips"
```

---

### Task 8: 恢复最近会话 + 新对话按钮 + 列表轮询与命名闪烁

**Files:**

- Create: `src/renderer/ai/use-restore-conversation.ts`
- Modify: `src/renderer/reader/ReaderView.tsx`（挂 hook）
- Modify: `src/renderer/ai/AIPanel.tsx`（newConversation 按钮）
- Modify: `src/renderer/reader/ConversationsTab.tsx`（轮询 + isNaming 动画）
- Test: 手测为主（store 逻辑已covered；hook 含 IPC 副作用）

- [ ] **Step 1: 恢复最近会话 hook**

Create `src/renderer/ai/use-restore-conversation.ts`：

```ts
import { useEffect } from "react";
import { useChatStore } from "@renderer/store/chat-store";

/**
 * 开书恢复最近会话（spec §7）：仅当 active 为空或不属于该书时，取该书 updatedAt 最新会话
 * 装入 active（restoreConversation：载历史但不强制开面板）；该书从无会话 → active 置 null
 * 并预亮摘要 chips（「将开启新会话」状态，spec §6）。
 */
export function useRestoreConversation(bookId: string | null) {
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;
    void window.api.chat.conversations
      .listByBook({ bookId })
      .then((list) => {
        if (cancelled) return;
        const s = useChatStore.getState();
        if (s.activeConversationId && list.some((c) => c.id === s.activeConversationId)) return;
        const latest = list[0]; // listByBook 已按 updatedAt 倒序
        if (latest) {
          s.restoreConversation(latest.id);
        } else {
          s.setActiveConversation(null);
          s.setSummaryChipsPreset();
        }
      })
      .catch((err: unknown) => console.warn("[chat] restore conversation failed:", err));
    return () => {
      cancelled = true;
    };
  }, [bookId]);
}
```

`src/renderer/reader/ReaderView.tsx`：组件顶部（`const bookId = ...` 之后）加 `useRestoreConversation(bookId);` 与 import。

- [ ] **Step 2: 新对话按钮新行为**

`src/renderer/ai/AIPanel.tsx` 的 `newConversation`（76-79 行）替换为：

```tsx
const newConversation = async () => {
  const bookId = useNavigationStore.getState().currentBookId;
  if (!bookId) return;
  try {
    // 显式创建空会话（spec §2/§7）；防堆积由主进程兜底（复用既有空会话）
    const convo = await window.api.chat.conversations.create({ bookId });
    setMessages([]);
    useChatStore.getState().setActiveConversation(convo.id);
    useChatStore.getState().setSummaryChipsPreset();
    void qc.invalidateQueries({ queryKey: ["conversations"] });
  } catch (err) {
    console.warn("[ai] create conversation failed:", err);
  }
};
```

（onClick 处 `onClick={() => void newConversation()}`；「active 置空→清面板」effect 保留——切书路径仍用。）

- [ ] **Step 3: 列表轮询 + 命名闪烁**

`src/renderer/reader/ConversationsTab.tsx` 的 convos query 改为：

```tsx
const convos = useQuery({
  queryKey: qk.conversations(bookId),
  queryFn: () => window.api.chat.conversations.listByBook({ bookId }),
  // isNaming 是主进程后台推进的瞬态（spec §5/§8）：staleTime:0 + 命名期间短轮询，
  // 终态（无 isNaming）即停——镜像 summary-queries 的非终态轮询取向。
  staleTime: 0,
  refetchInterval: (q) => (q.state.data?.some((c) => c.isNaming) ? 1200 : false),
});
```

item 标题 span 加闪烁（spec §8）：

```tsx
<span
  className={cn(
    "min-w-0 flex-1 truncate text-xs text-foreground",
    c.isNaming && "animate-pulse text-muted-foreground",
  )}
>
  {primaryLabel(c)}
</span>
```

- [ ] **Step 4: 发送结束触发列表刷新确认**

AIPanel 既有「发送结束 invalidate ["conversations"]」effect（62-69 行）保留——它让命名开始后的第一次列表刷新看到 `isNaming: true`，轮询随之接管直到写回。无需改动，确认存在即可。

- [ ] **Step 5: 验证 + Commit**

```bash
pnpm typecheck && pnpm test
git add -A && git commit -m "feat(reader): restore latest conversation on book open; naming shimmer in list"
```

---

### Task 9: i18n 同步 + 全量验证 + dev 库迁移冒烟

**Files:**

- Modify: `src/shared/i18n/locales/zh-CN.ts`、`en.ts`（i18n:extract 自动）
- 验证产物：无代码改动

- [ ] **Step 1: i18n extract**

```bash
pnpm i18n:extract
git diff src/shared/i18n/locales/
```

确认：新增 `ai.chip.chapterSummary` / `ai.chip.bookSummary` / `ai.noBookToSend` / `errors.conversationNotFound`；删除不再引用的 `reader.conversation.independent` / `ai.conversationSuffix` / `ai.noChapterToSend` / `errors.chapterNotInBook`。en.ts 的新 key 翻译为英文（extract 只 sync 主语言，en 需手动补：`Chapter summary` / `Book summary` / `No book is open; cannot send.` / `Conversation not found or belongs to another book`）。

提示（memory 坑）：i18n:lint 有漏报，用 `grep -rn "reader.conversation.independent" src/` 之类确认删净。

- [ ] **Step 2: 全量验证**

```bash
pnpm i18n:lint && pnpm typecheck && pnpm lint && pnpm test
```

Expected: 全绿。

- [ ] **Step 3: dev 库迁移冒烟（spec §3 硬要求）**

复制真实 dev 库到临时路径（绝不动原库），并记录迁移前两表行数：

```bash
cp "$HOME/Library/Application Support/marginalia-dev/marginalia.db" /tmp/migrate-smoke.db
sqlite3 /tmp/migrate-smoke.db "SELECT COUNT(*) FROM conversations; SELECT COUNT(*) FROM messages;"
```

（若路径不存在，用 `ls "$HOME/Library/Application Support/" | grep -i marginalia` 找实际目录名。）

Create `src/main/db/migrate-smoke.test.ts`（**临时文件，跑完删除**）——vitest 跑在 Electron 运行时，与 app 同 ABI，正好用来对真库副本跑迁移链：

```ts
import path from "node:path";
import fs from "node:fs";
import { sql } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import { createDb, runMigrations } from "@main/db/client";

const SMOKE_DB = "/tmp/migrate-smoke.db";
const MIGRATIONS = path.resolve(__dirname, "./migrations");

// 手动冒烟（spec §3）：真实 dev 库副本上跑迁移链（表重建 + messages 子表 FK 是已知坑场景）
describe.skipIf(!fs.existsSync(SMOKE_DB))("migration smoke on real dev db", () => {
  it("migrates and keeps conversations + messages intact", () => {
    const db = createDb(SMOKE_DB);
    runMigrations(db, MIGRATIONS);
    const [convos] = db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM conversations`);
    const [msgs] = db.all<{ n: number }>(sql`SELECT COUNT(*) AS n FROM messages`);
    const cols = db.all<{ name: string }>(sql`SELECT name FROM pragma_table_info('conversations')`);
    expect(cols.map((c) => c.name)).not.toContain("chapter_id");
    console.log("[smoke] conversations:", convos.n, "messages:", msgs.n);
  });
});
```

（`createDb` 若已内部跑迁移则 `runMigrations` 幂等无害；签名以 `src/main/db/client.ts` 实际导出为准——`:memory:` 测试均为 `createDb` + 显式 `runMigrations(db, MIGRATIONS)` 模式，照抄。）

```bash
pnpm test src/main/db/migrate-smoke.test.ts
sqlite3 /tmp/migrate-smoke.db ".tables"
rm src/main/db/migrate-smoke.test.ts /tmp/migrate-smoke.db
```

Expected: 测试 PASS、console 打出的两表行数与迁移前记录一致、`chapter_id` 列消失。

- [ ] **Step 4: 真启动冒烟（建议）**

```bash
pnpm start
```

手测清单（人工或 CDP）：导入/打开书 → 划词提问（自动建会话）→ 切章再问（**同一会话续写**，不再新建）→ 流结束后会话列表标题闪烁→变 AI 标题 → 点「+」新对话（摘要 chips 预亮）→ toggle 摘要 chip 后发送（气泡 chip 徽标含摘要）→ 重启 app 重开书（恢复最近会话）。

- [ ] **Step 5: changeset + 收尾提交**

```bash
pnpm changeset
# 用户向英文条目，例如：
# "Conversations are no longer tied to chapters — keep one continuous conversation while
#  reading across chapters. Summaries become user-controlled context chips, and conversations
#  get AI-generated titles after the first reply."
git add -A && git commit -m "chore: changeset for conversation-chapter decoupling"
```

实现全部完成后走 superpowers:finishing-a-development-branch（rebase 合 main、更新 ROADMAP——「会话 tab」段落补解耦记录、backlog 划掉「自动命名会话」）。

---

## 验收对照（spec → task）

| spec 节                                        | 任务                                         |
| ---------------------------------------------- | -------------------------------------------- |
| §3 schema/迁移                                 | Task 5、Task 9 Step 3                        |
| §4 契约（DTO/入参/chip 四元/三态）             | Task 2、4、5                                 |
| §5 send 校验 / 防堆积 / auto naming / isNaming | Task 4、5、6                                 |
| §6 摘要 chip 化（toggle/状态机/物化/未 ready） | Task 7                                       |
| §7 Renderer（store/恢复/懒建/按钮/header）     | Task 3、4、5、8                              |
| §8 列表 UI（单行/占位/闪烁）                   | Task 5、8                                    |
| §9 测试                                        | 各任务内嵌 + Task 9                          |
| §11 非目标                                     | 不实现（会话删除、按章过滤、跨书会话均不做） |
