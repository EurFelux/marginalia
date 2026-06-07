import {
  blob,
  check,
  index,
  integer,
  real,
  sqliteTable,
  text,
  unique,
} from "drizzle-orm/sqlite-core";
import { sql } from "drizzle-orm";
import { v7 as uuidv7 } from "uuid";
import type { UIMessage } from "ai";
import type { AiProviderApiType } from "@shared/providers";
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
    // 当前选用的 API 端点格式（须 ∈ compatibleApis）。
    type: text("type", {
      enum: ["openai-responses", "openai-chat-completions", "anthropic", "google-generate-content"],
    }).notNull(),
    // 兼容的 API 格式集合（JSON）；内置且 length>1 时允许在其中切 type。
    compatibleApis: text("compatible_apis", { mode: "json" }).$type<AiProviderApiType[]>(),
    label: text("label"),
    baseUrl: text("base_url"),
    apiKey: text("api_key"),
    models: text("models", { mode: "json" }).$type<string[]>(),
    // 内置（启动时按 DEFAULT_PROVIDERS 补齐）provider：label / baseUrl 不可改、不可删；type 仅可在 compatibleApis 内切。
    isBuiltin: integer("is_builtin", { mode: "boolean" }).notNull().default(false),
    createdAt: nowMs(),
  },
  (t) => [
    check(
      "providers_type_check",
      sql`${t.type} in ('openai-responses','openai-chat-completions','anthropic','google-generate-content')`,
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

export const books = sqliteTable(
  "books",
  {
    id: text("id").primaryKey(), // 内容稳定 ID：ePub 取 dc:identifier（缺失回退文件哈希）；PDF 恒为文件哈希（#50 记有统一议题）
    title: text("title"),
    author: text("author"),
    cover: blob("cover", { mode: "buffer" }),
    toc: text("toc", { mode: "json" }).$type<TocNode[]>(),
    // 全书摘要正文：唯一持久化的事实。状态（pending/generating/ready/unavailable）是运行时派生，
    // 不入 DB——summary!=null=ready，内存 inFlight=generating，内存 failed=unavailable，否则 pending。
    summary: text("summary"),
    // 文档格式判别：双引擎分发的依据（spec 2026-06-06-pdf-support §4）。
    format: text("format", { enum: ["epub", "pdf"] })
      .notNull()
      .default("epub"),
    pageCount: integer("page_count"), // PDF 专用；epub 为 null
    // 扫描版检测结果（导入时落库）；epub 恒 true。false ⇒ AI/标注功能门控。
    hasTextLayer: integer("has_text_layer", { mode: "boolean" }).notNull().default(true),
    addedAt: integer("added_at")
      .notNull()
      .$defaultFn(() => Date.now()),
    // 手动排序位（#48）：默认 0；listBooks 按 (position, added_at) 排——既有书全 0 时按导入序平断，
    // 首次拖拽全量重写后 position 唯一。新导入 = MIN(position) - 1（排最前）。无唯一约束：
    // 重复 position 以 added_at 平断（added_at 亦同则退 SQLite 隐式 rowid），下次拖拽全量重写自愈（spec §3）。
    position: integer("position").notNull().default(0),
  },
  (t) => [check("books_format_check", sql`${t.format} in ('epub','pdf')`)],
);

export const chapters = sqliteTable(
  "chapters",
  {
    id: pkUuid(), // uuidv7 代理键（spine id 跨书不唯一）
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    title: text("title"),
    orderIndex: integer("order_index"),
    href: text("href").notNull(), // spine 项 href（书内唯一定位）
    startPage: integer("start_page"), // PDF 章节页范围（1-based 闭区间）；epub 为 null
    endPage: integer("end_page"),
    summary: text("summary"),
  },
  (t) => [unique().on(t.bookId, t.href), index("chapters_book_id_idx").on(t.bookId)],
);

export const progress = sqliteTable(
  "progress",
  {
    bookId: text("book_id")
      .primaryKey()
      .references(() => books.id, { onDelete: "cascade" }),
    locator: text("locator").notNull(),
    // 0–1 阅读进度「展示快照」（#48）：reader 保存进度时顺手上送（locator 黑盒保持，主进程不解析）。
    // 老数据 null → shelf 卡不渲染进度行，读一次书即回填。
    percent: real("percent"),
    updatedAt: integer("updated_at")
      .notNull()
      .$defaultFn(() => Date.now()),
  },
  (t) => [
    check(
      "progress_percent_check",
      sql`${t.percent} is null or (${t.percent} >= 0 and ${t.percent} <= 1)`,
    ),
  ],
);

export const annotations = sqliteTable(
  "annotations",
  {
    id: pkUuid(),
    bookId: text("book_id")
      .notNull()
      .references(() => books.id, { onDelete: "cascade" }),
    style: text("style").notNull(), // yellow|green|blue|pink|purple|underline
    note: text("note").notNull().default(""),
    selectedText: text("selected_text").notNull(),
    locatorRange: text("locator_range").notNull(),
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
      .references(() => books.id, { onDelete: "cascade" }),
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
      .references(() => conversations.id, { onDelete: "cascade" }),
    role: text("role", { enum: ["system", "user", "assistant"] }).notNull(),
    parts: text("parts", { mode: "json" }).$type<UIMessage["parts"]>().notNull(),
    metadata: text("metadata", { mode: "json" }).$type<MessageMetadata>(),
    status: text("status", { enum: ["complete", "error", "aborted"] })
      .notNull()
      .default("complete"),
    seq: integer("seq").notNull(),
    createdAt: nowMs(),
  },
  (t) => [
    check("messages_role_check", sql`${t.role} in ('system','user','assistant')`),
    check("messages_status_check", sql`${t.status} in ('complete','error','aborted')`),
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
