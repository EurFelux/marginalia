import type { z } from "zod";
import { C, type Contract } from "@shared/ipc";
import type { AiStreamEvent } from "@shared/chat";
import type { PreferencesSnapshot } from "@shared/preferences";

/** 由注入的 invoke 生成类型化调用函数；类型从 contract 流出，零手写标注。__channel 供漂移测试走树收集。 */
export function invoker<S extends z.ZodType, O>(
  invoke: (channel: string, input: unknown) => Promise<unknown>,
  contract: Contract<S, O>,
): ((input: z.infer<S>) => Promise<O>) & { __channel: string } {
  const fn = (input: z.infer<S>) => invoke(contract.channel, input) as Promise<O>;
  return Object.assign(fn, { __channel: contract.channel });
}

/** createApi 的注入依赖：把所有 Electron 触点收敛到此，使 createApi 成为可 headless 测试的纯函数。 */
export interface PreloadDeps {
  invoke: (channel: string, input: unknown) => Promise<unknown>;
  /** 订阅某 channel；cb 收到 payload（已剥离 IpcRendererEvent）；返回退订函数。 */
  on: (channel: string, cb: (payload: unknown) => void) => () => void;
  getPathForFile: (file: File) => string;
  prefsSnapshot: PreferencesSnapshot;
  appLocale: string;
}

/** 构建 window.api（形状与重构前完全一致）。纯函数，依赖经 deps 注入。 */
export function createApi(d: PreloadDeps) {
  const inv = <S extends z.ZodType, O>(c: Contract<S, O>) => invoker(d.invoke, c);
  return {
    app: {
      getInfo: inv(C.appGetInfo),
      /** 系统 locale（启动同步快照，供 i18n 决定默认语言）。 */
      locale: d.appLocale,
      openLogsDir: inv(C.appOpenLogsDir),
      openExternal: inv(C.appOpenExternal),
    },
    log: {
      write: inv(C.logWrite),
    },
    ping: inv(C.ping),

    library: {
      import: inv(C.libraryImport),
      pickBook: inv(C.libraryPickBook),
      list: inv(C.libraryList),
      get: inv(C.libraryGet),
      readBookBytes: inv(C.libraryReadBookBytes),
      delete: inv(C.libraryDelete),
      update: inv(C.libraryUpdate),
      setFinished: inv(C.librarySetFinished),
      recentlyRead: inv(C.libraryRecentlyRead),
      reorder: inv(C.libraryReorder),
      /** 由拖入的 File 取磁盘路径（Electron 41 已移除 File.path，须经 webUtils）。同步、纯渲染端、非 IPC。 */
      pathForFile: (file: File) => d.getPathForFile(file),
    },

    progress: {
      get: inv(C.progressGet),
      save: inv(C.progressSave),
    },

    content: {
      toc: inv(C.contentToc),
      chapters: inv(C.contentChapters),
      chapterText: inv(C.contentChapterText),
      chapterSummary: inv(C.contentChapterSummary),
      generateChapterSummary: inv(C.contentGenerateChapterSummary),
      bookSummary: inv(C.contentBookSummary),
      generateBookSummary: inv(C.contentGenerateBookSummary),
    },

    annotations: {
      listByBook: inv(C.annotationsListByBook),
      create: inv(C.annotationsCreate),
      update: inv(C.annotationsUpdate),
      delete: inv(C.annotationsDelete),
    },

    bookNotes: {
      listByBook: inv(C.bookNotesListByBook),
      create: inv(C.bookNotesCreate),
      update: inv(C.bookNotesUpdate),
      delete: inv(C.bookNotesDelete),
    },

    preferences: {
      // 读同步（boot 时已取一次缓存于 prefsSnapshot）；写仍异步 fire-and-forget——非对称是有意的。
      // 注意：返回的是**启动快照**，不反映运行时 set() 的写入（仅启动 hydrate / theme-store 初始化各调一次；
      // 运行时态由各 store 在内存中持有）。勿在运行时重复调用 getAll() 当「当前值」读。
      getAll: () => d.prefsSnapshot,
      set: inv(C.preferencesSet),
    },

    settings: {
      providers: {
        list: inv(C.providersList),
        upsert: inv(C.providersUpsert),
        reveal: inv(C.providersReveal),
        test: inv(C.providersTest),
        remove: inv(C.providersRemove),
        listModels: inv(C.providersListModels),
      },
    },

    chat: {
      conversations: {
        listByBook: inv(C.conversationsListByBook),
        create: inv(C.conversationsCreate),
        delete: inv(C.conversationsDelete),
      },
      messages: {
        listByConversation: inv(C.messagesListByConversation),
      },
    },

    ai: {
      buildChips: inv(C.aiBuildChips),
      send: inv(C.aiSend),
      resend: inv(C.aiResend),
      abort: inv(C.aiAbort),
      /** 订阅本 streamId 的增量；返回退订函数。 */
      onChunk: (streamId: string, cb: (ev: AiStreamEvent) => void): (() => void) =>
        d.on(C.aiChunk.channel, (payload) => {
          const ev = payload as AiStreamEvent;
          if (ev.streamId === streamId) cb(ev);
        }),
    },

    stats: {
      readingState: inv(C.statsReadingState),
      get: inv(C.statsGet),
    },

    backup: {
      /** 导出备份（主进程开 saveDialog）；用户取消返回 null。 */
      export: inv(C.backupExport),
      /** 选包并检视（主进程开 openDialog）；取消返回 null，含兼容性结论供确认弹窗。 */
      inspect: inv(C.backupInspect),
      /** 整体替换还原；成功后主进程立即 relaunch（此调用不会正常 resolve）。 */
      restore: inv(C.backupRestore),
    },

    memories: {
      list: inv(C.memoriesList),
      update: inv(C.memoriesUpdate),
      delete: inv(C.memoriesDelete),
    },

    agent: {
      resetAvatar: inv(C.agentResetAvatar),
      setAvatar: inv(C.agentSetAvatar),
    },
  };
}

export type RendererApi = ReturnType<typeof createApi>;
