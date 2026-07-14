import { getDb } from "@main/db/instance";
import { appService } from "@main/app";
import { readBookFile } from "@main/library/book-files";
import { getBook } from "@main/library/repository";
import { resolveChatModel, resolveSummaryModel } from "@main/ai/assistant-model";
import { getPreference } from "@main/preferences/repository";
import { Limiter } from "@main/ai/background-limiter";
import { notifyRenderer } from "@main/notify";
import { DEFAULT_BACKGROUND_CONCURRENCY, DEFAULT_STEP_LIMIT } from "@shared/preferences";
import { createSearchTools } from "@main/ai/search/web-search-tool";
import { DEFAULT_WEB_SEARCH } from "@shared/web-search";
import type { DB } from "@main/db/client";
import type { SummaryDeps } from "@main/ai/summary";
import type { LoadBytes } from "@main/ai/tools";
import type { SendDeps } from "@main/ai/send";
import { runReadingReportAgent } from "@main/reading-report/agent";
import { ReadingReportRuntime } from "@main/reading-report/runtime";
import type { ReadingReportServiceDeps } from "@main/reading-report/service";

/** 进程级后台并发限流器。getLimit 惰性实时读 preference——改设置即时生效，模块加载期不碰 getDb。 */
const backgroundLimiter = new Limiter(
  () => getPreference(getDb(), "backgroundConcurrency") ?? DEFAULT_BACKGROUND_CONCURRENCY,
);

const readingReportRuntime = new ReadingReportRuntime();

/** (bookId) => 该书 app 自有副本字节；缺失抛 BookFileMissingError。注入 db/booksDir 以便单测。 */
export function createLoadBytes(booksDir: string, db: DB): LoadBytes {
  // async 闭包：让「book 不存在」的同步 throw 也统一成 rejected promise——
  // 非 async 时 .catch()/Promise.allSettled 消费方接不住同步异常。
  return async (bookId: string) => {
    const book = getBook(db, bookId);
    if (!book) throw new Error(`send-deps: book ${bookId} not found`);
    return readBookFile(booksDir, bookId, book.format);
  };
}

/** 组装 runSend 所需的全部生产依赖（注入 Electron 侧单例）。 */
export function makeSendDeps(): SendDeps {
  const db = getDb();
  const loadBytes = createLoadBytes(appService.getPath("booksDir"), db);
  const resolveModel = () => resolveChatModel(db);
  return {
    db,
    loadBytes,
    resolveModel,
    resolveSummaryModel: () => resolveSummaryModel(db),
    runBackground: backgroundLimiter.run,
    stepLimit: getPreference(db, "stepLimit") ?? DEFAULT_STEP_LIMIT,
    createSearchTools,
    webSearchConfig: getPreference(db, "webSearch") ?? DEFAULT_WEB_SEARCH,
    notify: notifyRenderer,
  };
}

/** 章摘懒生成所需依赖（供 content:generate-chapter-summary handler 用）。
 * 摘要（章节/全书）走独立 resolveSummaryModel（spec §5），不共享聊天模型。 */
export function makeSummaryDeps(): SummaryDeps {
  const db = getDb();
  return {
    db,
    loadBytes: createLoadBytes(appService.getPath("booksDir"), db),
    resolveModel: () => resolveSummaryModel(db),
    runBackground: backgroundLimiter.run,
  };
}

/** 完成阅读报告使用唯一的进程内运行时，摘要模型与普通聊天模型严格分离。 */
export function makeReadingReportDeps(): ReadingReportServiceDeps {
  const db = getDb();
  return {
    db,
    loadBytes: createLoadBytes(appService.getPath("booksDir"), db),
    resolveModel: () => resolveSummaryModel(db),
    runBackground: backgroundLimiter.run,
    runAgent: runReadingReportAgent,
    runtime: readingReportRuntime,
    now: () => Temporal.Now.instant(),
  };
}
