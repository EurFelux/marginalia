import { z } from "zod";
import type { TocNode } from "@shared/types";
import type {
  BookSummaryContentDto,
  BookSummaryDto,
  ChapterRefDto,
  ChapterSummaryDto,
  ChapterTextSlice,
  RecentlyReadDto,
} from "@shared/library";
import {
  bookIdInput,
  chapterRefInput,
  generateChapterSummaryInput,
  importBookInput,
  readChapterTextInput,
  reorderBooksInput,
  saveProgressInput,
  setBookFinishedInput,
  updateBookInput,
} from "@shared/library";
import type { ListModelsResult, ProviderDto, RevealResult, TestResult } from "@shared/providers";
import {
  listModelsInput,
  providerIdInput,
  testProviderInput,
  upsertProviderInput,
} from "@shared/providers";
import type { AiStreamEvent, Chip, ConversationDto, MessageDto, SendAck } from "@shared/chat";
import {
  abortInput,
  buildChipsInput,
  conversationIdInput,
  createConversationInput,
  messagesByConversationInput,
  resendRequest,
  sendRequest,
} from "@shared/chat";
import type { AnnotationDto } from "@shared/annotations";
import {
  annotationIdInput,
  createAnnotationInput,
  updateAnnotationInput,
} from "@shared/annotations";
import type { BookNoteDto } from "@shared/book-notes";
import { bookNoteIdInput, createBookNoteInput, updateBookNoteInput } from "@shared/book-notes";
import type { PreferencesSnapshot } from "@shared/preferences";
import { setPreferenceInput } from "@shared/preferences";
import type { ReadingStatsDto } from "@shared/stats";
import { statsGetInput, statsReadingStateInput } from "@shared/stats";
import type { BackupExportResult, BackupInspection } from "@shared/backup";
import { backupRestoreInput } from "@shared/backup";
import type { MemoryDto } from "@shared/memory";
import { deleteMemoryInput, updateMemoryInput } from "@shared/memory";
import type { AvatarPickResult } from "@shared/agent";

/** ping —— 演示"带入参且经 Zod 校验"的往返 */
export const pingInput = z.object({ msg: z.string().min(1) });

export const openExternalInput = z.object({ url: z.string().min(1) });
export type OpenExternalInput = z.infer<typeof openExternalInput>;

/** log:write —— 渲染层日志经 IPC 落 renderer-*.log。
 * 长度上限是渲染层暴露面的第一层防御（防异常对象/被污染的 renderer 灌爆日志）；
 * 主进程 logger 内部还有第二层截断（BODY_MAX，兜不走 IPC 的调用），故此处上限取宽。 */
export const logWriteInput = z.object({
  level: z.enum(["error", "warn", "info", "debug"]),
  module: z.string().min(1).max(64),
  message: z.string().max(16_384),
});
export type LogWriteInput = z.infer<typeof logWriteInput>;
export type PingInput = z.infer<typeof pingInput>;
export const pingResult = z.object({ echo: z.string() });
export type PingResult = z.infer<typeof pingResult>;

/** app:get-info —— 无入参，返回版本与书数 */
export const appGetInfoResult = z.object({
  version: z.string(),
  bookCount: z.number().int().nonnegative(),
});
export type AppGetInfoResult = z.infer<typeof appGetInfoResult>;

/** app:check-update —— 更新检测结果（判别联合，discriminator=status） */
export const updateCheckResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("update-available"),
    currentVersion: z.string(),
    latestVersion: z.string(),
    releaseUrl: z.string(),
  }),
  z.object({
    status: z.literal("up-to-date"),
    currentVersion: z.string(),
    latestVersion: z.string(),
  }),
  z.object({
    status: z.literal("error"),
    currentVersion: z.string(),
    message: z.string(),
  }),
]);
export type UpdateCheckResult = z.infer<typeof updateCheckResult>;

/** output 幽灵类型载体：零运行时值，仅在类型层携带 O（main 不做 output 运行时校验，故无需 schema）。 */
declare const OUT: unique symbol;
export interface Out<O> {
  readonly [OUT]: O;
}
export const out = <O>(): Out<O> => ({}) as Out<O>;

export type IpcKind = "invoke" | "sync" | "event";

/** 单条 IPC 契约：通道名 + 种类 + input Zod schema + output 类型载体。 */
export interface Contract<S extends z.ZodType = z.ZodType, O = unknown> {
  channel: string;
  kind: IpcKind;
  input: S;
  output: Out<O>;
}

export type ContractMap = Record<string, Contract>;

export type InferIn<C> = C extends Contract<infer S, infer _O> ? z.infer<S> : never;
export type InferOut<C> = C extends Contract<z.ZodType, infer O> ? O : never;

/** 定义一条契约，保留 S/O 的精确推导（供 bind/invoker 推类型）。 */
function def<S extends z.ZodType, O>(
  channel: string,
  kind: IpcKind,
  input: S,
  output: Out<O>,
): Contract<S, O> {
  return { channel, kind, input, output };
}

/**
 * IPC 契约单一真相源：新增/改通道只动这里。
 * input schema 复用各 domain 文件定义；output 为类型载体（不校验）。
 */
export const C = {
  // app / ping
  appGetInfo: def("app:get-info", "invoke", z.void(), out<AppGetInfoResult>()),
  appGetLocaleSync: def("app:get-locale-sync", "sync", z.void(), out<string>()),
  appOpenExternal: def("app:open-external", "invoke", openExternalInput, out<void>()),
  ping: def("ping", "invoke", pingInput, out<PingResult>()),

  // library
  libraryImport: def("library:import", "invoke", importBookInput, out<BookSummaryDto>()),
  libraryList: def("library:list", "invoke", z.void(), out<BookSummaryDto[]>()),
  libraryGet: def("library:get", "invoke", bookIdInput, out<BookSummaryDto | null>()),
  libraryPickBook: def("library:pick-book", "invoke", z.void(), out<string | null>()),
  libraryReadBookBytes: def("library:read-book-bytes", "invoke", bookIdInput, out<Uint8Array>()),
  libraryDelete: def("library:delete", "invoke", bookIdInput, out<void>()),
  libraryUpdate: def("library:update", "invoke", updateBookInput, out<BookSummaryDto>()),
  librarySetFinished: def(
    "library:set-finished",
    "invoke",
    setBookFinishedInput,
    out<BookSummaryDto>(),
  ),
  libraryRecentlyRead: def("library:recently-read", "invoke", z.void(), out<RecentlyReadDto[]>()),
  libraryReorder: def("library:reorder", "invoke", reorderBooksInput, out<void>()),

  // progress
  progressGet: def("progress:get", "invoke", bookIdInput, out<{ locator: string } | null>()),
  progressSave: def("progress:save", "invoke", saveProgressInput, out<void>()),

  // content
  contentToc: def("content:toc", "invoke", bookIdInput, out<TocNode[]>()),
  contentChapters: def("content:chapters", "invoke", bookIdInput, out<ChapterRefDto[]>()),
  contentChapterText: def(
    "content:chapter-text",
    "invoke",
    readChapterTextInput,
    out<ChapterTextSlice>(),
  ),
  contentChapterSummary: def(
    "content:chapter-summary",
    "invoke",
    chapterRefInput,
    out<ChapterSummaryDto>(),
  ),
  contentGenerateChapterSummary: def(
    "content:generate-chapter-summary",
    "invoke",
    generateChapterSummaryInput,
    out<ChapterSummaryDto>(),
  ),
  contentBookSummary: def(
    "content:book-summary",
    "invoke",
    bookIdInput,
    out<BookSummaryContentDto>(),
  ),
  contentGenerateBookSummary: def(
    "content:generate-book-summary",
    "invoke",
    bookIdInput,
    out<BookSummaryContentDto>(),
  ),

  // annotations
  annotationsListByBook: def(
    "annotations:list-by-book",
    "invoke",
    bookIdInput,
    out<AnnotationDto[]>(),
  ),
  annotationsCreate: def(
    "annotations:create",
    "invoke",
    createAnnotationInput,
    out<AnnotationDto>(),
  ),
  annotationsUpdate: def(
    "annotations:update",
    "invoke",
    updateAnnotationInput,
    out<AnnotationDto>(),
  ),
  annotationsDelete: def("annotations:delete", "invoke", annotationIdInput, out<void>()),

  // book notes（书籍级独立笔记，独立于选区标注）
  bookNotesListByBook: def("book-notes:list-by-book", "invoke", bookIdInput, out<BookNoteDto[]>()),
  bookNotesCreate: def("book-notes:create", "invoke", createBookNoteInput, out<BookNoteDto>()),
  bookNotesUpdate: def("book-notes:update", "invoke", updateBookNoteInput, out<BookNoteDto>()),
  bookNotesDelete: def("book-notes:delete", "invoke", bookNoteIdInput, out<void>()),

  // settings: providers
  providersList: def("providers:list", "invoke", z.void(), out<ProviderDto[]>()),
  providersUpsert: def("providers:upsert", "invoke", upsertProviderInput, out<ProviderDto>()),
  providersReveal: def("providers:reveal", "invoke", providerIdInput, out<RevealResult>()),
  providersTest: def("providers:test", "invoke", testProviderInput, out<TestResult>()),
  providersRemove: def("providers:remove", "invoke", providerIdInput, out<void>()),
  providersListModels: def(
    "providers:list-models",
    "invoke",
    listModelsInput,
    out<ListModelsResult>(),
  ),

  // chat（conversationsGet 为 main-only：有 handler、preload 不暴露）
  conversationsListByBook: def(
    "conversations:list-by-book",
    "invoke",
    bookIdInput,
    out<ConversationDto[]>(),
  ),
  conversationsCreate: def(
    "conversations:create",
    "invoke",
    createConversationInput,
    out<ConversationDto>(),
  ),
  conversationsGet: def(
    "conversations:get",
    "invoke",
    conversationIdInput,
    out<ConversationDto | null>(),
  ),
  conversationsDelete: def("conversations:delete", "invoke", conversationIdInput, out<void>()),
  messagesListByConversation: def(
    "messages:list-by-conversation",
    "invoke",
    messagesByConversationInput,
    out<MessageDto[]>(),
  ),

  // ai
  aiBuildChips: def("ai:build-chips", "invoke", buildChipsInput, out<Chip[]>()),
  aiSend: def("ai:send", "invoke", sendRequest, out<SendAck>()),
  aiResend: def("ai:resend", "invoke", resendRequest, out<SendAck>()),
  aiAbort: def("ai:abort", "invoke", abortInput, out<void>()),
  aiChunk: def("ai:chunk", "event", z.void(), out<AiStreamEvent>()),

  // preferences
  preferencesGetAllSync: def(
    "preferences:get-all-sync",
    "sync",
    z.void(),
    out<PreferencesSnapshot>(),
  ),
  preferencesSet: def("preferences:set", "invoke", setPreferenceInput, out<void>()),

  // stats（阅读时长）
  statsReadingState: def("stats:reading-state", "invoke", statsReadingStateInput, out<void>()),
  statsGet: def("stats:get", "invoke", statsGetInput, out<ReadingStatsDto>()),

  // backup
  backupExport: def("backup:export", "invoke", z.void(), out<BackupExportResult | null>()),
  backupInspect: def("backup:inspect", "invoke", z.void(), out<BackupInspection | null>()),
  backupRestore: def("backup:restore", "invoke", backupRestoreInput, out<void>()),

  // memories
  memoriesList: def("memories:list", "invoke", z.void(), out<MemoryDto[]>()),
  memoriesUpdate: def("memories:update", "invoke", updateMemoryInput, out<MemoryDto | null>()),
  memoriesDelete: def("memories:delete", "invoke", deleteMemoryInput, out<void>()),

  // logging
  logWrite: def("log:write", "invoke", logWriteInput, out<void>()),
  appOpenLogsDir: def("app:open-logs-dir", "invoke", z.void(), out<void>()),

  // agent（头像）
  agentResetAvatar: def("agent:reset-avatar", "invoke", z.void(), out<void>()),
  agentSetAvatar: def(
    "agent:set-avatar",
    "invoke",
    z.instanceof(Uint8Array),
    out<AvatarPickResult>(),
  ),
};
