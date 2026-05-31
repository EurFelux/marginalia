import { blob, check, integer, sqliteTable, text, unique } from "drizzle-orm/sqlite-core";
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
  id: text("id").primaryKey(), // ePub 自然键（缺失回退文件哈希）
  path: text("path").notNull(),
  title: text("title"),
  author: text("author"),
  cover: blob("cover", { mode: "buffer" }),
  toc: text("toc", { mode: "json" }).$type<TocNode[]>(),
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

export const conversations = sqliteTable("conversations", {
  id: pkUuid(),
  bookId: text("book_id").references(() => books.id),
  chapterId: text("chapter_id").references(() => chapters.id), // NULL = 独立会话
  assistantId: text("assistant_id").references(() => assistants.id),
  title: text("title"),
  createdAt: nowMs(),
  updatedAt: integer("updated_at")
    .notNull()
    .$defaultFn(() => Date.now()),
});

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
  (t) => [check("messages_role_check", sql`${t.role} in ('system','user','assistant')`)],
);
