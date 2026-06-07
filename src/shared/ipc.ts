import { z } from "zod";
import type { TocNode } from "@shared/types";
import type {
  BookSummaryContentDto,
  BookSummaryDto,
  ChapterRefDto,
  ChapterSummaryDto,
  ChapterTextSlice,
} from "@shared/library";
import {
  bookIdInput,
  chapterRefInput,
  generateChapterSummaryInput,
  importBookInput,
  readChapterTextInput,
  saveProgressInput,
  updateBookInput,
} from "@shared/library";
import type { ListModelsResult, ProviderDto, RevealResult, TestResult } from "@shared/providers";
import {
  listModelsInput,
  providerIdInput,
  testProviderInput,
  upsertProviderInput,
} from "@shared/providers";
import type { AssistantDto } from "@shared/assistant";
import { updateAssistantInput } from "@shared/assistant";
import type { AiStreamEvent, Chip, ConversationDto, MessageDto, SendAck } from "@shared/chat";
import {
  abortInput,
  buildChipsInput,
  conversationIdInput,
  createConversationInput,
  messagesByConversationInput,
  sendRequest,
} from "@shared/chat";
import type { AnnotationDto } from "@shared/annotations";
import {
  annotationIdInput,
  createAnnotationInput,
  updateAnnotationInput,
} from "@shared/annotations";
import type { PreferencesSnapshot } from "@shared/preferences";
import { setPreferenceInput } from "@shared/preferences";

/** ping —— 演示"带入参且经 Zod 校验"的往返 */
export const pingInput = z.object({ msg: z.string().min(1) });

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
  ping: def("ping", "invoke", pingInput, out<PingResult>()),

  // library
  libraryImport: def("library:import", "invoke", importBookInput, out<BookSummaryDto>()),
  libraryList: def("library:list", "invoke", z.void(), out<BookSummaryDto[]>()),
  libraryGet: def("library:get", "invoke", bookIdInput, out<BookSummaryDto | null>()),
  libraryPickBook: def("library:pick-book", "invoke", z.void(), out<string | null>()),
  libraryReadBookBytes: def("library:read-book-bytes", "invoke", bookIdInput, out<Uint8Array>()),
  libraryDelete: def("library:delete", "invoke", bookIdInput, out<void>()),
  libraryUpdate: def("library:update", "invoke", updateBookInput, out<BookSummaryDto>()),

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

  // settings: providers + assistant
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
  assistantGetDefault: def("assistant:get-default", "invoke", z.void(), out<AssistantDto>()),
  assistantUpdate: def("assistant:update", "invoke", updateAssistantInput, out<AssistantDto>()),

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

  // logging
  logWrite: def("log:write", "invoke", logWriteInput, out<void>()),
  appOpenLogsDir: def("app:open-logs-dir", "invoke", z.void(), out<void>()),
};
