import { ipcMain } from "electron";
import type { z } from "zod";
import { validateInput } from "@main/ipc/validate";

/** 注册一个经 Zod 校验入参的 IPC handler。无入参时传 z.undefined()。 */
export function handle<I, O>(
  channel: string,
  inputSchema: z.ZodType<I>,
  handler: (input: I) => O | Promise<O>,
): void {
  ipcMain.handle(channel, (_event, raw: unknown) => {
    const input = validateInput(channel, inputSchema, raw);
    return handler(input);
  });
}
