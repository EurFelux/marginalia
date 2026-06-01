import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import { validateInput } from "@main/ipc/validate";

/**
 * 注册一个经 Zod 校验的 invoke handler。
 * handler 第二参为 IpcMainInvokeEvent（流式通道需要 event.sender）；不需要的 handler 忽略即可。
 */
export function handle<I, O>(
  channel: string,
  inputSchema: z.ZodType<I>,
  handler: (input: I, event: IpcMainInvokeEvent) => O | Promise<O>,
): void {
  ipcMain.handle(channel, async (event, raw: unknown) => {
    try {
      const input = validateInput(channel, inputSchema, raw);
      return await handler(input, event);
    } catch (err) {
      console.error(`[ipc] ${channel} failed:`, err);
      throw err;
    }
  });
}
