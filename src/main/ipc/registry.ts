import { ipcMain, type IpcMainInvokeEvent } from "electron";
import type { z } from "zod";
import { validateInput } from "@main/ipc/validate";
import type { Contract } from "@shared/ipc";

/** 声明式绑定：契约 + 业务 fn，纯数据、不碰 Electron（供 headless 覆盖测试读取）。 */
export interface Binding {
  contract: Contract;
  fn: (input: never, event: IpcMainInvokeEvent) => unknown;
}

/** 把契约与业务 fn 绑成一条 Binding；input 类型由契约 input schema 推导，返回值被 output 类型约束。 */
export function bind<S extends z.ZodType, O>(
  contract: Contract<S, O>,
  fn: (input: z.infer<S>, event: IpcMainInvokeEvent) => NoInfer<O> | Promise<NoInfer<O>>,
): Binding {
  return { contract, fn: fn as Binding["fn"] };
}

/** 唯一碰 ipcMain 的地方：为每条 Binding 注册经 Zod 校验的 invoke handler。 */
export function register(bindings: Binding[]): void {
  for (const { contract, fn } of bindings) {
    ipcMain.handle(contract.channel, async (event, raw: unknown) => {
      try {
        const input = validateInput(contract.channel, contract.input, raw);
        return await (fn as (i: unknown, e: IpcMainInvokeEvent) => unknown)(input, event);
      } catch (err) {
        console.error(`[ipc] ${contract.channel} failed:`, err);
        throw err;
      }
    });
  }
}
