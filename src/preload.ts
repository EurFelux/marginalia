import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type AppGetInfoResult, type PingInput, type PingResult } from "@shared/ipc";
import type {
  BookIdInput,
  BookSummaryContentDto,
  BookSummaryDto,
  ChapterRefDto,
  ChapterRefInput,
  ChapterSummaryDto,
  ChapterTextSlice,
  ImportBookInput,
  ReadChapterTextInput,
  SaveProgressInput,
} from "@shared/library";
import type { TocNode } from "@shared/types";
import type {
  ListModelsInput,
  ListModelsResult,
  ProviderDto,
  ProviderIdInput,
  RevealResult,
  TestProviderInput,
  TestResult,
  UpsertProviderInput,
} from "@shared/providers";
import type { AssistantDto, UpdateAssistantInput } from "@shared/assistant";
import type {
  AbortInput,
  AiStreamEvent,
  BuildChipsInput,
  Chip,
  ConversationDto,
  MessageDto,
  MessagesByConversationInput,
  SendAck,
  SendRequest,
} from "@shared/chat";
import type {
  AnnotationDto,
  AnnotationIdInput,
  CreateAnnotationInput,
  UpdateAnnotationInput,
} from "@shared/annotations";
import type { PreferencesSnapshot, SetPreferenceInput } from "@shared/preferences";

// 首帧前同步读整份偏好快照（read 仅启动一次）：供渲染层同步初始化 theme-store（挂 .dark）+ hydrate。
// 注意：挂 .dark 的 DOM 操作放在 renderer 入口（src/renderer.tsx），不在此处——sandbox preload 模块求值时
// document.documentElement 尚为 null，在此 toggle 会抛错并令整个 preload（含 contextBridge 暴露）失败。
const prefsSnapshot = ipcRenderer.sendSync(IPC.preferencesGetAllSync) as PreferencesSnapshot;

const api = {
  app: {
    getInfo: (): Promise<AppGetInfoResult> => ipcRenderer.invoke(IPC.appGetInfo),
  },
  ping: (input: PingInput): Promise<PingResult> => ipcRenderer.invoke(IPC.ping, input),

  library: {
    import: (input: ImportBookInput): Promise<BookSummaryDto> =>
      ipcRenderer.invoke(IPC.libraryImport, input),
    pickEpub: (): Promise<string | null> => ipcRenderer.invoke(IPC.libraryPickEpub),
    list: (): Promise<BookSummaryDto[]> => ipcRenderer.invoke(IPC.libraryList),
    get: (input: BookIdInput): Promise<BookSummaryDto | null> =>
      ipcRenderer.invoke(IPC.libraryGet, input),
    readEpubBytes: (input: BookIdInput): Promise<Uint8Array> =>
      ipcRenderer.invoke(IPC.libraryReadEpubBytes, input),
  },

  progress: {
    get: (input: BookIdInput): Promise<{ cfi: string } | null> =>
      ipcRenderer.invoke(IPC.progressGet, input),
    save: (input: SaveProgressInput): Promise<void> => ipcRenderer.invoke(IPC.progressSave, input),
  },

  content: {
    toc: (input: BookIdInput): Promise<TocNode[]> => ipcRenderer.invoke(IPC.contentToc, input),
    chapters: (input: BookIdInput): Promise<ChapterRefDto[]> =>
      ipcRenderer.invoke(IPC.contentChapters, input),
    chapterText: (input: ReadChapterTextInput): Promise<ChapterTextSlice> =>
      ipcRenderer.invoke(IPC.contentChapterText, input),
    chapterSummary: (input: ChapterRefInput): Promise<ChapterSummaryDto> =>
      ipcRenderer.invoke(IPC.contentChapterSummary, input),
    generateChapterSummary: (input: ChapterRefInput): Promise<ChapterSummaryDto> =>
      ipcRenderer.invoke(IPC.contentGenerateChapterSummary, input),
    bookSummary: (input: BookIdInput): Promise<BookSummaryContentDto> =>
      ipcRenderer.invoke(IPC.contentBookSummary, input),
    generateBookSummary: (input: BookIdInput): Promise<BookSummaryContentDto> =>
      ipcRenderer.invoke(IPC.contentGenerateBookSummary, input),
  },

  annotations: {
    listByBook: (input: BookIdInput): Promise<AnnotationDto[]> =>
      ipcRenderer.invoke(IPC.annotationsListByBook, input),
    create: (input: CreateAnnotationInput): Promise<AnnotationDto> =>
      ipcRenderer.invoke(IPC.annotationsCreate, input),
    update: (input: UpdateAnnotationInput): Promise<AnnotationDto> =>
      ipcRenderer.invoke(IPC.annotationsUpdate, input),
    delete: (input: AnnotationIdInput): Promise<void> =>
      ipcRenderer.invoke(IPC.annotationsDelete, input),
  },

  preferences: {
    // 读同步（boot 时已取一次缓存于 prefsSnapshot）；写仍异步 fire-and-forget——非对称是有意的。
    // 注意：返回的是**启动快照**，不反映运行时 set() 的写入（仅启动 hydrate / theme-store 初始化各调一次；
    // 运行时态由各 store 在内存中持有）。勿在运行时重复调用 getAll() 当「当前值」读。
    getAll: (): PreferencesSnapshot => prefsSnapshot,
    set: (input: SetPreferenceInput): Promise<void> =>
      ipcRenderer.invoke(IPC.preferencesSet, input),
  },

  settings: {
    providers: {
      list: (): Promise<ProviderDto[]> => ipcRenderer.invoke(IPC.providersList),
      upsert: (input: UpsertProviderInput): Promise<ProviderDto> =>
        ipcRenderer.invoke(IPC.providersUpsert, input),
      reveal: (input: ProviderIdInput): Promise<RevealResult> =>
        ipcRenderer.invoke(IPC.providersReveal, input),
      test: (input: TestProviderInput): Promise<TestResult> =>
        ipcRenderer.invoke(IPC.providersTest, input),
      remove: (input: ProviderIdInput): Promise<void> =>
        ipcRenderer.invoke(IPC.providersRemove, input),
      listModels: (input: ListModelsInput): Promise<ListModelsResult> =>
        ipcRenderer.invoke(IPC.providersListModels, input),
    },
    assistant: {
      getDefault: (): Promise<AssistantDto> => ipcRenderer.invoke(IPC.assistantGetDefault),
      update: (input: UpdateAssistantInput): Promise<AssistantDto> =>
        ipcRenderer.invoke(IPC.assistantUpdate, input),
    },
  },

  chat: {
    conversations: {
      listByBook: (input: BookIdInput): Promise<ConversationDto[]> =>
        ipcRenderer.invoke(IPC.conversationsListByBook, input),
    },
    messages: {
      listByConversation: (input: MessagesByConversationInput): Promise<MessageDto[]> =>
        ipcRenderer.invoke(IPC.messagesListByConversation, input),
    },
  },

  ai: {
    buildChips: (input: BuildChipsInput): Promise<Chip[]> =>
      ipcRenderer.invoke(IPC.aiBuildChips, input),
    send: (input: SendRequest): Promise<SendAck> => ipcRenderer.invoke(IPC.aiSend, input),
    abort: (input: AbortInput): Promise<void> => ipcRenderer.invoke(IPC.aiAbort, input),
    /** 订阅本 streamId 的增量；返回退订函数。 */
    onChunk: (streamId: string, cb: (ev: AiStreamEvent) => void): (() => void) => {
      const listener = (_e: IpcRendererEvent, payload: AiStreamEvent) => {
        if (payload.streamId === streamId) cb(payload);
      };
      ipcRenderer.on(IPC.aiChunk, listener);
      return () => ipcRenderer.removeListener(IPC.aiChunk, listener);
    },
  },
};

contextBridge.exposeInMainWorld("api", api);

export type RendererApi = typeof api;
