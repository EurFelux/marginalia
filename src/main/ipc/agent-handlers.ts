import { readFile } from "node:fs/promises";
import { BrowserWindow, dialog } from "electron";
import { C } from "@shared/ipc";
import type { AvatarPickResult } from "@shared/agent";
import { getDb } from "@main/db/instance";
import { storeAvatar, resetAvatar } from "@main/ai/agent-avatar";
import { bind, register, type Binding } from "@main/ipc/registry";
import { createLogger } from "@main/logger";

const log = createLogger("agent");

export const agentBindings: Binding[] = [
  bind(C.agentPickAvatar, async (): Promise<AvatarPickResult> => {
    const win = BrowserWindow.getFocusedWindow();
    const opts = {
      properties: ["openFile" as const],
      filters: [{ name: "Images", extensions: ["png", "jpg", "jpeg", "webp", "gif"] }],
    };
    const r = win ? await dialog.showOpenDialog(win, opts) : await dialog.showOpenDialog(opts);
    if (r.canceled || r.filePaths.length === 0) return { status: "cancelled" };
    let bytes: Uint8Array;
    try {
      bytes = new Uint8Array(await readFile(r.filePaths[0]));
    } catch (err) {
      log.warn("read avatar file failed", err);
      return { status: "unsupported" };
    }
    return storeAvatar(getDb(), bytes);
  }),

  bind(C.agentResetAvatar, () => resetAvatar(getDb())),
];

export function registerAgentHandlers(): void {
  register(agentBindings);
}
