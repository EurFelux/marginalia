# 类型设计债清理 · 实现计划

> **For agentic workers:** 本计划配合 superpowers:executing-plans 逐任务执行（控制者在本会话内联 TDD）。步骤用 checkbox 跟踪。

**Goal:** 把 `ProviderDto` 密钥三态、`ConversationDto` 章节/独立态、`conversations` 可空列、`ChatModel` 的 SDK 内部类型耦合，分别收紧为判别联合 / NOT NULL / 直接类型依赖，让非法状态不可表示。

**Architecture:** 纯类型/约束收紧，零新增运行时行为。三个独立任务，各自可单独提交。回归判据＝191 测试维持全绿。

**Tech Stack:** TypeScript 6 strict · Zod 4 · Drizzle ORM 1.0-rc · better-sqlite3 · vitest 4（Electron ABI，headless）。

设计来源：`docs/superpowers/specs/2026-06-03-type-design-debt-cleanup-design.md`。

---

## Task 1: `ProviderDto` 密钥判别联合（item 1）

**Files:**

- Modify: `src/shared/providers.ts`（DTO + 新 `ProviderKeyState`）
- Modify: `src/main/providers/repository.ts:12-34`（`toDto`）
- Modify: `src/renderer/settings/SettingsPanel.tsx:88,91,110`（消费方）
- Test: `src/main/providers/repository.test.ts:56-58,71-73,134-140`

- [ ] **Step 1: 改测试断言（先红）** — `repository.test.ts` 三处：
  - 「有密钥」：`expect(dto.key).toEqual({ status: "set", mask: "sk-…ghij" })`（替换 `hasKey/keyDecryptable/keyMask` 三断言）
  - 「无密钥」：`expect(dto.key).toEqual({ status: "none" })`
  - 「解密失败」：`expect(listed?.key).toEqual({ status: "undecryptable" })`

- [ ] **Step 2: 跑测试确认失败** — `pnpm test src/main/providers/repository.test.ts`，预期 FAIL（`key` 未定义 / 旧字段消失类型错误）。

- [ ] **Step 3: 改 DTO** — `src/shared/providers.ts` 用 §3.1 的 `ProviderKeyState` 替换 `keyMask`/`hasKey`/`keyDecryptable` 三字段为 `key: ProviderKeyState`。

```ts
export type ProviderKeyState =
  | { status: "none" }
  | { status: "set"; mask: string }
  | { status: "undecryptable" };
```

- [ ] **Step 4: 改生产者** — `repository.ts` `toDto`：

```ts
function keyState(cipher: Buffer | null, encryptor: Encryptor): ProviderKeyState {
  if (cipher == null) return { status: "none" };
  try {
    return { status: "set", mask: maskKey(encryptor.decrypt(cipher)) };
  } catch (err) {
    console.warn(`[providers] toDto: decrypt failed for provider:`, err);
    return { status: "undecryptable" };
  }
}
// toDto 中 keyMask/hasKey/keyDecryptable 三字段 → key: keyState(cipher, encryptor)
```

（保留原 `cipher` 取值与 `console.warn`；`Buffer | null` 按 `row.apiKeyEncrypted` 实际类型。）

- [ ] **Step 5: 改消费方** — `SettingsPanel.tsx`：
  - `anthropic?.hasKey`（两处，line 88/110）→ `anthropic?.key.status !== "none"`
  - `anthropic.keyMask ?? "已配置（本机无法解密）"` → `anthropic.key.status === "set" ? anthropic.key.mask : "已配置（本机无法解密）"`

- [ ] **Step 6: 跑测试 + typecheck** — `pnpm test src/main/providers/repository.test.ts` 全绿；`pnpm typecheck` 无错（SettingsPanel 收窄正确）。

- [ ] **Step 7: 提交** — `git add -A && git commit -m "refactor(types): collapse ProviderDto key flags into a discriminated union"`（prek 改文件则重 add 再提）。

---

## Task 2: `ConversationDto` 判别联合 + `NOT NULL` 迁移（items 2 + 3）

**Files:**

- Modify: `src/main/db/schema.ts:119-133`（`conversations` 列）
- Create: `src/main/db/migrations/<ts>_<name>/`（`db:generate` 产出）
- Modify: `src/shared/chat.ts:43-51`（`ConversationDto`）
- Modify: `src/main/chat/conversations.ts:10-20`（`toDto`）
- Test: `src/main/chat/messages.test.ts:18-26,84-94`（fixture）、`src/main/chat/conversations.test.ts:38-46`（补 `kind`）

- [ ] **Step 1: 改 fixture（先红）** — `messages.test.ts`：import 加 `assistants`；`seedConversation` 内先 `const a = db.insert(assistants).values({ name: "Test" }).returning().get();`，conversation 插入用 `assistantId: a.id`；line 84-94 的两处内联插入同样先播种 assistant 再引用（可提 `seedAssistant(db)` 辅助函数复用）。

- [ ] **Step 2: 改 schema** — `schema.ts` `conversations`：`bookId` 与 `assistantId` 链上加 `.notNull()`（见 §3.2），`chapterId` 不变。

- [ ] **Step 3: 生成迁移** — `pnpm db:generate`；核验新 `migration.sql` 为建新表→拷贝→换名、保留 FK 与 `conversations_book_id_idx`，列 `book_id`/`assistant_id` 为 `NOT NULL`。**不手编**。

- [ ] **Step 4: 改 DTO** — `chat.ts`：用 §3.2 的 `ConversationBase` + `kind` 判别联合替换扁平 `ConversationDto`。

- [ ] **Step 5: 改生产者** — `conversations.ts` `toDto`：

```ts
function toDto(row: ConversationRow): ConversationDto {
  const base = {
    id: row.id,
    bookId: row.bookId,
    assistantId: row.assistantId,
    title: row.title ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
  return row.chapterId === null
    ? { ...base, kind: "independent", chapterId: null }
    : { ...base, kind: "chapter", chapterId: row.chapterId };
}
```

- [ ] **Step 6: 补 `kind` 断言** — `conversations.test.ts` 「creates a conversation bound to the default assistant」加 `expect(convo.kind).toBe("independent")`；「creates a new chapter conversation」处可加 `expect(getConversation(db, r.conversationId)?.kind).toBe("chapter")`。

- [ ] **Step 7: 跑测试 + typecheck** — `pnpm test src/main/chat/` 全绿；`pnpm typecheck` 无错（注意 `routeConversation` 读裸 row 的 `active.bookId` 现为 `string`，比较仍合法）。再 `pnpm test` 全量确认 191 维持。

- [ ] **Step 8: 提交** — `git add -A && git commit -m "refactor(types): model ConversationDto as a kind-discriminated union; tighten conversations.book_id/assistant_id to NOT NULL"`。

---

## Task 3: `ChatModel` → `LanguageModelV3`（item 5）

**Files:**

- Modify: `package.json`（声明 `@ai-sdk/provider`）
- Modify: `src/main/ai/model-factory.ts:7-12`

- [ ] **Step 1: 声明直接依赖** — `pnpm add @ai-sdk/provider@^3.0.10`（已在 node_modules，仅提为直接依赖）。

- [ ] **Step 2: 翻回 Electron ABI** — `pnpm db:rebuild:electron`（install 把 better-sqlite3 重编为 Node ABI 137，须翻回 145）。

- [ ] **Step 3: 改类型** — `model-factory.ts`：

```ts
import type { LanguageModelV3 } from "@ai-sdk/provider";
// 删除 createOpenAI 仅用于推导类型的残留（仍用于 resolveLanguageModel 运行时）
export type ChatModel = LanguageModelV3;
```

删除原 `ReturnType<ReturnType<typeof createOpenAI>>` 与漂移风险注释，替为一行说明（四家工厂均返回 `LanguageModelV3`）。

- [ ] **Step 4: typecheck + 全量测试** — `pnpm typecheck` 无错（`resolveLanguageModel` 各 `case` 返回值赋给 `ChatModel` 通过）；`pnpm test` 191 全绿（确认 ABI 已翻回、原生模块可加载）。

- [ ] **Step 5: 提交** — `git add -A && git commit -m "refactor(types): depend on @ai-sdk/provider LanguageModelV3 directly for ChatModel"`。

---

## 收尾

- [ ] 全量 `pnpm typecheck && pnpm lint && pnpm test` 绿。
- [ ] 更新 `docs/superpowers/ROADMAP.md`：「类型设计债」段勾掉 1/2/3/5，注明 4/6 暂缓原因。
- [ ] 走 `finishing-a-development-branch`（rebase-merge 入 main）。
