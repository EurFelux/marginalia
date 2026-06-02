# 类型设计债清理 · 设计文档

> 状态：已确认范围（用户 2026-06-03 拍板「清 1/2/3/5，4&6 暂缓」）。本轮清理 ROADMAP「类型设计债」段中**有真实消费方或解耦价值**的 4 项；两项零消费方的投机项有意延后。

## 1. 背景与动机

竖切落地后，渲染层刚开始接 preload，是「趁迁移成本低收紧类型」的窗口期。多处 DTO/类型用扁平布尔或宽 `string | null` 表达本应互斥的状态，类型上允许**非法组合**（生产者不会产出，但类型不禁止）。本轮把这些收紧为**判别联合 / NOT NULL / 直接类型依赖**，让非法状态不可表示，并解除一处对 SDK 内部返回类型的耦合。

## 2. 范围

| #   | 项                                     | 现状                                                 | 目标                                   | 消费方                                 |
| --- | -------------------------------------- | ---------------------------------------------------- | -------------------------------------- | -------------------------------------- |
| 1   | `ProviderDto` 密钥三态                 | `hasKey`/`keyDecryptable`/`keyMask` 三独立字段       | `key` 判别联合                         | `SettingsPanel`(3) + `repository.test` |
| 2   | `ConversationDto` 章节/独立            | `bookId`/`chapterId`/`assistantId` 三 `string\|null` | `kind` 判别联合                        | 仅主进程（渲染层零读）                 |
| 3   | `conversations.assistantId` / `bookId` | 列可空                                               | 收紧 `NOT NULL`（迁移）                | 测试 fixture                           |
| 5   | `ChatModel`                            | `ReturnType<ReturnType<typeof createOpenAI>>`        | 直接 `import type { LanguageModelV3 }` | 主进程 AI 层                           |

**有意延后（零消费方，YAGNI）：**

- **4 `Chip.required`/`enabled` 闭合联合**：仅定义+测试，零读取方；延后条件「UI toggle 落地」未到。本轮收敛=对不存在的消费方猜形状。
- **6 具名 `ReadingTools` + `InferUITools`**：「当需要收紧 tool-result chunk 时」才做，当前无消费方。

二者保留现状与既有 `TODO` 注释，待 UI toggle / 精确 chunk 渲染落地时按实际需求收敛。

## 3. 各项设计

### 3.1 `ProviderDto` 密钥判别联合（item 1）

三布尔可表达 8 种组合，但合法仅 3 种：无密钥、有且可解密、有但本机不可解密。收敛为：

```ts
// src/shared/providers.ts
export type ProviderKeyState =
  | { status: "none" } //                密文不存在
  | { status: "set"; mask: string } //   密文存在且本机可解密，附掩码预览
  | { status: "undecryptable" }; //      密文存在但本机无法解密（跨机迁移 / safeStorage 不可用）

export interface ProviderDto {
  id: string;
  type: ProviderType;
  label: string | null;
  baseUrl: string | null;
  key: ProviderKeyState;
  createdAt: number;
}
```

**生产者** `src/main/providers/repository.ts` 的 `toDto`：把现有 try/catch 的三布尔赋值改为返回 `ProviderKeyState`（`cipher == null` → `none`；解密成功 → `{set, mask}`；解密抛错（保留 `console.warn`）→ `undecryptable`）。

**消费者** `src/renderer/settings/SettingsPanel.tsx`：

- `anthropic?.hasKey`（= 密文存在）→ `anthropic?.key.status !== "none"`。
- `anthropic.keyMask ?? "已配置（本机无法解密）"` → `anthropic.key.status === "set" ? anthropic.key.mask : "已配置（本机无法解密）"`。

**测试** `repository.test.ts`：三处断言改为对 `dto.key.status` 收窄后断言（`set`+`mask`、`none`、`undecryptable`）。

### 3.2 `ConversationDto` 判别联合 + NOT NULL 迁移（items 2 + 3）

**领域事实**：会话恒属某书（无 app 级全局会话），恒有默认 Assistant；唯一真实变化维度是 `chapterId`（有=章节会话 / null=独立会话）。故把 `book_id`、`assistant_id` 双双收紧 `NOT NULL`，`chapter_id` 保持可空。这比记忆里「仅加 `CHECK chapter_id IS NULL OR book_id IS NOT NULL`」更强且更简——book 恒非空时该 CHECK 被平凡满足、无需再加。

**Schema** `src/main/db/schema.ts`：

```ts
bookId: text("book_id").notNull().references(() => books.id),
chapterId: text("chapter_id").references(() => chapters.id), // NULL = 独立会话
assistantId: text("assistant_id").notNull().references(() => assistants.id),
```

迁移用 `pnpm db:generate` 生成（SQLite 加 NOT NULL 走建新表→拷贝→换名；产物须人工核验保留 FK/index，**不手编**）。

**DTO** `src/shared/chat.ts`：

```ts
interface ConversationBase {
  id: string;
  bookId: string;
  assistantId: string;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}
export type ConversationDto =
  | (ConversationBase & { kind: "chapter"; chapterId: string })
  | (ConversationBase & { kind: "independent"; chapterId: null });
```

**生产者** `src/main/chat/conversations.ts` 的 `toDto`：去掉 `?? null` 兜底（列已 NOT NULL，`$inferSelect` 即 `string`），按 `row.chapterId === null` 分流构造两 arm。

**测试 fixture**：`src/main/chat/messages.test.ts` 三处裸插 `assistantId: null` → 改为先播种一个 assistant 行并引用其 id（新增 `assistants` import + 在 `seedConversation` 与第二处内联插入处播种）。`conversations.test.ts` 全走 `createConversation`（自动取默认 assistant），无需改 fixture；可补 `kind` 断言锁新不变量。

### 3.3 `ChatModel` 直接依赖 `LanguageModelV3`（item 5）

`@ai-sdk/provider@3.0.10` 已在 node_modules（`@ai-sdk/openai` 即从它导出 `LanguageModelV3`），现仅为传递依赖。声明为**直接依赖**后改：

```ts
// src/main/ai/model-factory.ts
import type { LanguageModelV3 } from "@ai-sdk/provider";
export type ChatModel = LanguageModelV3;
```

删除原 `ReturnType<ReturnType<...>>` 链与漂移风险注释（耦合已解除）。四家工厂返回值均声明为 `LanguageModelV3`，`resolveLanguageModel(): ChatModel` 应直接 typecheck 通过。

**ABI 坑**：声明依赖触发 `pnpm install`，按系统 Node 把 better-sqlite3 重编为 ABI 137；装完须跑一次 `pnpm db:rebuild:electron` 翻回 145，再 `pnpm test`（见 CLAUDE.md）。

## 4. 测试策略

全程 headless vitest（`:memory:` SQLite，Electron ABI）。每项收尾跑 `pnpm typecheck` + `pnpm test`，迁移项额外人工核验生成的 `migration.sql`。无新增运行时行为——纯类型/约束收紧，回归判据＝191 测试维持全绿（fixture 改动后数目不变）。

## 5. 非目标

- 不动 items 4、6（见 §2）。
- 不改 IPC 通道名/入参 schema（DTO 是出站视图，renderer 消费方收敛即可）。
- 不做全 schema 级 `ON DELETE CASCADE`（独立 backlog，删书功能落地前统一定）。
