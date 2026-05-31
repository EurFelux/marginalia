import { z } from "zod";

/** IPC 通道名（main 注册 / preload 调用 共用） */
export const IPC = {
  appGetInfo: "app:get-info",
  ping: "ping",
  libraryImport: "library:import",
  libraryList: "library:list",
  libraryGet: "library:get",
  progressGet: "progress:get",
  progressSave: "progress:save",
  contentToc: "content:toc",
  contentChapterText: "content:chapter-text",
  contentChapterSummary: "content:chapter-summary",
} as const;

/** ping —— 演示"带入参且经 Zod 校验"的往返 */
export const pingInput = z.object({ msg: z.string().min(1) });
export type PingInput = z.infer<typeof pingInput>;
export const pingResult = z.object({ echo: z.string() });
export type PingResult = z.infer<typeof pingResult>;

/** app:get-info —— 无入参，返回版本与书数 */
export const appGetInfoResult = z.object({
  version: z.string(),
  bookCount: z.number().int().nonnegative(),
});
export type AppGetInfoResult = z.infer<typeof appGetInfoResult>;
