import { blob, check, index, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { UIMessage } from "ai";
import type { MessageMetadata, TocNode } from "@shared/types";

const pkUuid = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => uuidv7());
const nowMs = () =>
  integer("created_at")
    .notNull()
    .$defaultFn(() => Date.now());

export const providers = sqliteTable(
  "providers",
  {
    id: pkUuid(),
    type: text("type", {
      enum: ["openai", "anthropic", "google", "openai-compatible"],
    }).notNull(),
    label: text("label"),
    baseUrl: text("base_url"),
    apiKeyEncrypted: blob("api_key_encrypted", { mode: "buffer" }),
    models: text("models", { mode: "json" }).$type<string[]>(),
    // 内置（启动时按 DEFAULT_PROVIDERS 补齐）provider：type / label / baseUrl 不可改、不可删（仅 key + models 可编辑）。
    isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
    createdAt: nowMs(),
  },
  (t) => [
    check(
      "providers_type_check",
      sql`${t.type} in ('openai','anthropic','google','openai-compatible')`,
    ),
  ],
);

export const assistants = sqliteTable("assistants", {
  id: pkUuid(),
  name: text("name").notNull(),
  systemPrompt: text("system_prompt"),
  providerId: text("provider_id").references(() => providers.id),
  model: text("model"),
  createdAt: nowMs(),
});

export const books = sqliteTable("books", {
  id: text("id").primaryKey(), // ePub 自然键，由导入流程提供（标识符缺失时回退文件哈希）
  path: text("path").notNull(),
  title: text("title"),
  author: text("author"),
  cover: blob("cover", { mode: "buffer" }),
  toc: text("toc", { mode: "json" }).$type<TocNode[]>(),
  // 全书摘要正文：唯一持久化的事实。状态（pending/generating/ready/unavailable）是运行时派生，
  // 不入 DB——summary!=null=ready，内存 inFlight=generating，内存 failed=unavailable，否则 pending。
  summary: text("summary"),
  addedAt: integer("added_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const chapters = sqliteTable(
  "chapters",
  {
    id: pkUuid(), // uuidv7 代理键（spine id 跨书不唯一）
    bookId: text("book_id")
      .notNull()
      .references(() => books.id),
    title: text("title"),
    orderIndex: integer("order_index"),
    href: text("href").notNull(), // spine 项 href（书内唯一定位）
    summary: text("summary"),
    summaryStatus: text("summary_status", {
      enum: ["pending", "generating", "ready", "unavailable"],
    })
      .notNull()
      .default("pending"),
  },
  (t) => [
    unique().on(t.bookId, t.href),
    check(
      "chapters_summary_status_check",
      sql`${t.summaryStatus} in ('pending','generating','ready','unavailable')`,
    ),
    index("chapters_book_id_idx").on(t.bookId),
  ],
);

export const progress = sqliteTable("progress", {
  bookId: text("book_id")
    .primaryKey()
    .references(() => books.id),
  cfi: text("cfi").notNull(),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

export const annotations = sqliteTable(
  "annotations",
  {
    id: pkUuid(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id),
    style: text("style").notNull(), // yellow|green|blue|pink|purple|underline
    note: text("note").notNull().default(""),
    selectedText: text("selected_text").notNull(),
    cfiRange: text("cfi_range").notNull(),
    createdAt: nowMs(),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    check(
      "annotations_style_check",
      sql`${t.style} in ('yellow','green','blue','pink','purple','underline')`,
    ),
    index("annotations_book_id_idx").on(t.bookId),
  ],
);

export const conversations = sqliteTable(
  "conversations",
  {
    id: pkUuid(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id),
    chapterId: text("chapter_id").references(() => chapters.id), // NULL = 独立会话
    assistantId: text("assistant_id")
      .notNull()
      .references(() => assistants.id),
    title: text("title"),
    createdAt: nowMs(),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [index("conversations_book_id_idx").on(t.bookId)],
);

export const messages = sqliteTable(
  "messages",
  {
    id: pkUuid(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id),
    role: text("role", { enum: ["system", "user", "assistant"] }).notNull(),
    parts: text("parts", { mode: "json" }).$type<UIMessage["parts"]>().notNull(),
    metadata: text("metadata", { mode: "json" }).$type<MessageMetadata>(),
    seq: integer("seq").notNull(),
    createdAt: nowMs(),
  },
  (t) => [
    check("messages_role_check", sql`${t.role} in ('system','user','assistant')`),
    unique("messages_conversation_seq_unique").on(t.conversationId, t.seq),
    index("messages_conversation_id_idx").on(t.conversationId),
  ],
);

// 用户偏好持久化：key → 任意 JSON value（按 @shared/preferences 的 Zod schema 在服务层校验）。
export const preferences = sqliteTable("preferences", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>().notNull(),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});
