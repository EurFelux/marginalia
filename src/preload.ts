import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import { IPC, type AppGetInfoResult, type PingInput, type PingResult } from "@shared/ipc";
import type {
  BookIdInput,
  BookSummaryDto,
  ChapterRefDto,
  ChapterTextSlice,
  ImportBookInput,
  ReadChapterTextInput,
} from "@shared/library";
import type { TocNode } from "@shared/types";
import type {
  ProviderDto,
  ProviderIdInput,
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
  },

  content: {
    toc: (input: BookIdInput): Promise<TocNode[]> => ipcRenderer.invoke(IPC.contentToc, input),
    chapters: (input: BookIdInput): Promise<ChapterRefDto[]> =>
      ipcRenderer.invoke(IPC.contentChapters, input),
    chapterText: (input: ReadChapterTextInput): Promise<ChapterTextSlice> =>
      ipcRenderer.invoke(IPC.contentChapterText, input),
  },

  settings: {
    providers: {
      list: (): Promise<ProviderDto[]> => ipcRenderer.invoke(IPC.providersList),
      upsert: (input: UpsertProviderInput): Promise<ProviderDto> =>
        ipcRenderer.invoke(IPC.providersUpsert, input),
      test: (input: TestProviderInput): Promise<TestResult> =>
        ipcRenderer.invoke(IPC.providersTest, input),
      remove: (input: ProviderIdInput): Promise<void> =>
        ipcRenderer.invoke(IPC.providersRemove, input),
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
